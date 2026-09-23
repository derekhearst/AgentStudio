import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'

/**
 * Symlink-aware containment for the per-user sandbox.
 *
 * A lexical check (`path.resolve` plus a prefix test) is not enough on its own. The
 * agent's Bash can `ln -s` anything inside its workspace, and an imported repo can
 * commit a symlink, so `<workspace>/x/secrets` can be lexically inside the workspace
 * while the file the OS actually opens is `/etc`, the server's environment, or another
 * user's tree. Everything server-side that opens a workspace path (the in-house file
 * tools, the rail preview, attachments, project knowledge) follows those links, so
 * containment has to be decided on the path the OS will really use.
 *
 * Synchronous on purpose: `safePathWithin` has always been synchronous and has a dozen
 * callers, and resolving a handful of path components is a few cheap syscalls.
 *
 * What this cannot close is the window between the check and the open: a process that
 * swaps a link after we looked wins that race. Closing it needs `openat2` with
 * `RESOLVE_BENEATH`, which Node does not expose.
 */

/** Same limit the kernel applies before it gives up with ELOOP. */
const MAX_LINK_HOPS = 40

/** What separates path components: either slash on Windows, only `/` elsewhere. */
const SEPARATORS = process.platform === 'win32' ? /[\\/]+/ : /\/+/

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code
}

/** A component is missing, or a component that should be a directory is a file. */
function isMissing(error: unknown): boolean {
	const code = errorCode(error)
	return code === 'ENOENT' || code === 'ENOTDIR'
}

function hasParentSegment(path: string): boolean {
	return path.split(SEPARATORS).includes('..')
}

/**
 * The path the OS will actually reach for `target`, with every symlink resolved.
 *
 * A path that does not exist yet (a file about to be written, a directory about to be
 * made) is walked one component at a time, following each link as it is reached, and
 * whatever is still missing at the end is kept as a tail, because that is where the
 * eventual create lands. A dangling symlink counts as pointing where its target says:
 * `realpath` refuses it, but a write through it still creates the file there.
 *
 * `..` is the subtle part. The kernel follows a link first and then takes `..` from
 * wherever it really led, so `s/../x` with `s -> /elsewhere/dir` means `/elsewhere/x`,
 * while `path.resolve` would call it `./x`. Windows does the opposite and collapses `..`
 * in the string. A spelling whose two readings land in different places is refused
 * rather than guessed at (see `follow`).
 *
 * Throws on a symlink loop, on such an ambiguous `..`, or on a component that cannot be
 * inspected (EACCES). Callers treat that as a refusal.
 */
export function resolveRealPath(target: string): string {
	if (!hasParentSegment(target)) {
		// Common case: the whole path exists and `realpath` answers in one call.
		try {
			return realpathSync.native(resolve(target))
		} catch (error) {
			if (!isMissing(error)) throw error
		}
	}
	return canonical(follow(process.cwd(), target, { hops: 0 }))
}

type Walk = { hops: number }

/**
 * Where `path` leads when it is opened from the directory `from`, which is already a
 * real (or not-yet-existing) location.
 *
 * Walked the way POSIX does it: each `..` applies to the real directory reached so far.
 * If `path` has a `..`, it is also walked the way Windows does it (`..` collapsed in the
 * string first). When those disagree, a `..` came right after a link, and the answer
 * depends on which OS is opening the file. Throw instead of picking one.
 *
 * Both walks share the hop budget, so a chain of links cannot fan out into more work
 * than `MAX_LINK_HOPS` links' worth.
 */
function follow(from: string, path: string, walk: Walk): string {
	const physical = walkComponents(from, path, walk)
	if (!hasParentSegment(path)) return physical
	const lexical = walkComponents(from, resolve(from, path), walk)
	if (
		comparable(physical) !== comparable(lexical) &&
		comparable(canonical(physical)) !== comparable(canonical(lexical))
	) {
		throw Object.assign(
			new Error(`Path means different things depending on how ".." is resolved: ${path}`),
			{ code: 'EAMBIGUOUS' },
		)
	}
	return physical
}

function walkComponents(from: string, path: string, walk: Walk): string {
	let current = from
	let rest = path
	if (isAbsolute(path)) {
		current = parse(path).root
		rest = path.slice(current.length)
	}
	for (const segment of rest.split(SEPARATORS)) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			// `current` never holds a link (each one was followed as it was reached), so
			// its parent is the real parent.
			current = dirname(current)
			continue
		}
		current = step(join(current, segment), walk)
	}
	return current
}

/** One component. If it is a link, the walk continues from wherever the link points. */
function step(candidate: string, walk: Walk): string {
	let isLink: boolean
	try {
		isLink = lstatSync(candidate).isSymbolicLink()
	} catch (error) {
		// Not there (yet): nothing to follow, and nothing below it can be a link either.
		if (isMissing(error)) return candidate
		throw error
	}
	if (!isLink) return candidate
	walk.hops += 1
	if (walk.hops > MAX_LINK_HOPS) {
		throw Object.assign(new Error(`Too many levels of symbolic links: ${candidate}`), { code: 'ELOOP' })
	}
	// A relative target is relative to the directory the link really lives in.
	return follow(dirname(candidate), readlinkSync(candidate), walk)
}

/**
 * Spell a link-free path the way the filesystem does (case, Windows short names) by
 * resolving its longest existing prefix and keeping the missing tail as written.
 */
function canonical(path: string): string {
	try {
		return realpathSync.native(path)
	} catch (error) {
		if (!isMissing(error)) throw error
	}
	const parent = dirname(path)
	if (parent === path) return path
	return join(canonical(parent), basename(path))
}

function comparable(p: string): string {
	// Windows paths are case-insensitive. Elsewhere the case is the identity.
	return process.platform === 'win32' ? p.toLowerCase() : p
}

/** True when `candidate` is `root` itself or lives underneath it. Both must be absolute. */
export function isPathWithin(root: string, candidate: string): boolean {
	const r = comparable(root)
	const c = comparable(candidate)
	if (c === r) return true
	const rootWithSep = r.endsWith(sep) ? r : `${r}${sep}`
	return c.startsWith(rootWithSep)
}

/**
 * True when `candidate` stays inside `root` once every symlink on both is resolved.
 *
 * Both sides are resolved, so a workspace whose root is itself reached through a link
 * (macOS's `/var` → `/private/var`, a mounted volume) still contains its own files.
 * A path that cannot be resolved (a link loop, a permission error) is not contained.
 */
export function isRealPathWithin(root: string, candidate: string): boolean {
	try {
		return isPathWithin(resolveRealPath(root), resolveRealPath(candidate))
	} catch {
		return false
	}
}
