import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

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

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code
}

/** A component is missing, or a component that should be a directory is a file. */
function isMissing(error: unknown): boolean {
	const code = errorCode(error)
	return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The path the OS will actually reach for `target`, with every symlink resolved.
 *
 * A path that does not exist yet (a file about to be written, a directory about to be
 * made) resolves its nearest existing ancestor and re-appends the missing tail, because
 * that ancestor is where the eventual create lands. A dangling symlink is followed by
 * hand: `realpath` refuses it, but a write through it still creates the file wherever
 * it points, so it has to count as pointing there.
 *
 * Throws on a symlink loop or on a component that cannot be inspected (EACCES). Callers
 * treat that as a refusal.
 */
export function resolveRealPath(target: string): string {
	return resolveWithHops(resolve(target), 0)
}

function resolveWithHops(absolute: string, hops: number): string {
	try {
		return realpathSync.native(absolute)
	} catch (error) {
		if (!isMissing(error)) throw error
	}

	let isLink = false
	try {
		isLink = lstatSync(absolute).isSymbolicLink()
	} catch (error) {
		if (!isMissing(error)) throw error
	}

	const parent = dirname(absolute)
	if (!isLink) {
		// Nothing here yet. The filesystem root is its own parent, which ends the walk.
		if (parent === absolute) return absolute
		return join(resolveWithHops(parent, hops), basename(absolute))
	}

	// A dangling link. Resolve its target against the *real* parent: `..` in a link
	// target is relative to where the link really lives, not to the lexical path.
	if (hops >= MAX_LINK_HOPS) {
		throw Object.assign(new Error(`Too many levels of symbolic links: ${absolute}`), { code: 'ELOOP' })
	}
	const realParent = resolveWithHops(parent, hops)
	return resolveWithHops(resolve(realParent, readlinkSync(absolute)), hops + 1)
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
