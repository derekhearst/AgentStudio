import { readdir, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'

/**
 * #22 — the list of files `@` can mention: every file and folder under a workspace root.
 *
 * Containment, because this walks a tree the agent can write to:
 *
 * - Symlinks are never followed, or listed. `readdir` reports a link as a link, so a link
 *   the agent's Bash made (or a cloned repo committed) to `/`, the server's environment or
 *   another user's tree is skipped, not walked. Before each directory is read, its real
 *   path is checked to still be under the root, which catches a directory swapped for a
 *   link after it was listed.
 * - Only names leave this module, as `/`-separated paths relative to the root. No absolute
 *   path, and no file contents.
 * - No child process. Not `git ls-files` — git honours the repo's own `.git/config`, which
 *   the agent can write, and options like `core.fsmonitor` run a program on the host
 *   outside the sandbox — and not `rg`, which the image does not ship.
 *
 * Cost is bounded three ways (entries, depth and time), and a finished listing is cached per
 * root for a few seconds, because the menu searches it again on every keystroke.
 */

/** Folders that are never worth mentioning and are often enormous. Other dotfolders stay. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
	'.git',
	'.hg',
	'.svn',
	'node_modules',
	'.svelte-kit',
	'build',
	'dist',
	'.next',
	'.turbo',
	'.cache',
	'coverage',
	'target',
	'__pycache__',
	'.venv',
	'venv',
])

export type WalkOptions = {
	/** Stop after this many entries (files and folders together). */
	maxEntries: number
	/** Do not descend more than this many folders below the root. */
	maxDepth: number
	/** Give up and return what was found after this long. */
	timeBudgetMs: number
}

export const DEFAULT_WALK: WalkOptions = { maxEntries: 20_000, maxDepth: 16, timeBudgetMs: 1_500 }

export type WorkspaceFileIndex = {
	/** Relative, `/`-separated; folders end in `/`. Shallow entries come first. */
	entries: string[]
	/** True when a limit cut the walk short, so some entries are missing. */
	truncated: boolean
}

// Control characters would put a line break or worse into the message box.
const UNPRINTABLE = /[\u0000-\u001f\u007f]/

function isWithin(realRoot: string, candidate: string): boolean {
	const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
	return candidate === realRoot || candidate.startsWith(prefix)
}

/**
 * Walk `root` breadth-first, so when a limit is reached the entries kept are the shallow
 * ones people mention most. Throws if `root` itself cannot be resolved (it does not exist).
 */
export async function listWorkspaceFiles(root: string, options: Partial<WalkOptions> = {}): Promise<WorkspaceFileIndex> {
	const { maxEntries, maxDepth, timeBudgetMs } = { ...DEFAULT_WALK, ...options }
	const realRoot = await realpath(root)
	const startedAt = Date.now()
	const entries: string[] = []
	let truncated = false

	const queue: Array<{ absolute: string; relative: string; depth: number }> = [
		{ absolute: realRoot, relative: '', depth: 0 },
	]
	walk: for (let head = 0; head < queue.length; head++) {
		if (Date.now() - startedAt > timeBudgetMs) {
			truncated = true
			break
		}
		const dir = queue[head]
		if (dir.depth > 0) {
			// Listed as a directory, but it could have been replaced by a link since.
			const real = await realpath(dir.absolute).catch(() => null)
			if (!real || !isWithin(realRoot, real)) continue
		}
		let dirents
		try {
			dirents = await readdir(dir.absolute, { withFileTypes: true })
		} catch {
			continue
		}
		dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		for (const dirent of dirents) {
			if (dirent.isSymbolicLink() || UNPRINTABLE.test(dirent.name)) continue
			const isDirectory = dirent.isDirectory()
			if (!isDirectory && !dirent.isFile()) continue
			if (isDirectory && IGNORED_DIRECTORIES.has(dirent.name)) continue
			if (entries.length >= maxEntries) {
				truncated = true
				break walk
			}
			const relative = dir.relative ? `${dir.relative}/${dirent.name}` : dirent.name
			if (isDirectory) {
				entries.push(`${relative}/`)
				if (dir.depth + 1 < maxDepth) {
					queue.push({ absolute: join(dir.absolute, dirent.name), relative, depth: dir.depth + 1 })
				} else {
					truncated = true
				}
			} else {
				entries.push(relative)
			}
		}
	}

	return { entries, truncated }
}

// ─────────── Cache ───────────

/** Long enough to cover a burst of keystrokes; short enough that a new file shows up soon. */
export const INDEX_TTL_MS = 15_000
const MAX_CACHED_ROOTS = 32

const cache = new Map<string, { builtAt: number; index: WorkspaceFileIndex }>()
const building = new Map<string, Promise<WorkspaceFileIndex>>()

/**
 * The listing for `root`, from the cache when it is fresh. Concurrent callers for the same
 * root share one walk. `now` is injectable for the spec.
 */
export async function getWorkspaceFileIndex(
	root: string,
	options: { now?: () => number; walk?: Partial<WalkOptions> } = {},
): Promise<WorkspaceFileIndex> {
	const now = options.now ?? Date.now
	const hit = cache.get(root)
	if (hit && now() - hit.builtAt < INDEX_TTL_MS) {
		// Most recently used moves to the back, so eviction takes the stalest root.
		cache.delete(root)
		cache.set(root, hit)
		return hit.index
	}

	const pending = building.get(root)
	if (pending) return pending

	const walk = listWorkspaceFiles(root, options.walk)
		.then((index) => {
			cache.delete(root)
			cache.set(root, { builtAt: now(), index })
			while (cache.size > MAX_CACHED_ROOTS) cache.delete(cache.keys().next().value!)
			return index
		})
		.finally(() => building.delete(root))
	building.set(root, walk)
	return walk
}

/** For specs: forget every cached listing. */
export function clearWorkspaceFileIndex() {
	cache.clear()
}
