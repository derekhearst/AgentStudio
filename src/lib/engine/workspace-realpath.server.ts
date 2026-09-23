/**
 * Where a path really leads, once links are followed.
 *
 * `./workspace-guard` decides containment lexically, on purpose: it is pure, and a pure check
 * cannot race the read that follows it. But lexical containment trusts every directory on the
 * way down. A workspace can hold a link that points out of it — committed in an imported
 * repository, or made by a sandboxed shell command (`ln -s / x` needs no write outside the
 * workspace) — and `Write('x/etc/cron.d/job')` is lexically inside the workspace while the
 * SDK's file tools, which run outside the sandbox, follow the link wherever it goes.
 *
 * So the engine asks this module too, before any file call runs: resolve the deepest part of
 * each path that exists to its real location, re-attach the rest, and check that against
 * the workspace's own real location. A path that does not exist yet has no link to follow
 * beyond its existing ancestors, which is exactly the part that gets resolved.
 */

import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { filesystemPathsFor, isInside } from './workspace-guard'

/** The real location of `path`: its deepest existing ancestor resolved, the rest re-attached. */
export async function realLocation(path: string): Promise<string> {
	const rest: string[] = []
	let current = path
	for (;;) {
		try {
			const real = await realpath(current)
			return rest.length > 0 ? join(real, ...rest.reverse()) : real
		} catch {
			const parent = dirname(current)
			// Reached the filesystem root without finding anything that exists.
			if (parent === current) return path
			rest.push(basename(current))
			current = parent
		}
	}
}

/**
 * The first path in this call that really leads outside the workspace, or null when every
 * one stays inside. Only meaningful for a call the lexical guard already allowed.
 */
export async function realPathEscape(
	toolName: string,
	toolInput: unknown,
	workspaceRoot: string,
): Promise<string | null> {
	const paths = filesystemPathsFor(toolName, toolInput, workspaceRoot)
	if (paths.length === 0) return null
	const root = await realLocation(workspaceRoot)
	for (const path of paths) {
		if (!isInside(root, await realLocation(path))) return path
	}
	return null
}
