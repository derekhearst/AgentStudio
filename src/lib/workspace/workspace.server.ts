import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const DEFAULT_SANDBOX_ROOT = '/workspace/users'

function sanitize(id: string, kind: string): string {
	if (!ID_PATTERN.test(id)) {
		throw new Error(`Invalid ${kind} for sandbox workspace: ${id}`)
	}
	return id
}

export type WorkspaceContext = {
	userId: string
	/** Run ID — when present and no persistentKey, the workspace is run-scoped (ephemeral). */
	runId?: string | null
	/**
	 * Stable opt-in workspace key (Phase 2). When set, the workspace resolves to
	 * `${sandboxRoot}/<userId>/persistent/<key>/` and survives across runs. Use for
	 * long-running coding agents that want a stable repo checkout.
	 *
	 * Takes precedence over `runId` — if both are passed, the persistent path wins.
	 */
	persistentKey?: string | null
	/**
	 * Absolute or relative path to the sandbox root directory. Pass the value of
	 * `$env/dynamic/private`'s `SANDBOX_WORKSPACE` here (the workspace module is
	 * SvelteKit-agnostic so unit tests can inject any root they want).
	 */
	sandboxRoot?: string
}

/**
 * Resolve the absolute root directory for a tool execution context.
 *
 * - With `persistentKey`: ${sandboxRoot}/<userId>/persistent/<key>  (Phase 2 — opt-in stable)
 * - Else with `runId`:    ${sandboxRoot}/<userId>/runs/<runId>      (Phase 1 — per-run isolation)
 * - Else:                  ${sandboxRoot}/<userId>                   (legacy path; back-compat for
 *   callers that haven't been migrated yet, e.g. ad-hoc/admin tool invocations outside a run loop)
 *
 * All three roots share a parent tree per user, so legacy persistent files at the user root
 * remain accessible to admin tooling but are invisible to ephemeral runs.
 */
export function resolveWorkspaceRoot(ctx: WorkspaceContext): string {
	const userId = sanitize(ctx.userId, 'userId')
	const root = ctx.sandboxRoot || DEFAULT_SANDBOX_ROOT
	if (ctx.persistentKey) {
		const key = sanitize(ctx.persistentKey, 'persistentKey')
		return resolve(root, userId, 'persistent', key)
	}
	if (ctx.runId) {
		const runId = sanitize(ctx.runId, 'runId')
		return resolve(root, userId, 'runs', runId)
	}
	return resolve(root, userId)
}

export function safePathWithin(workspaceRoot: string, userPath: string): string {
	const resolved = resolve(workspaceRoot, userPath)
	const rootWithSep = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`
	if (!(resolved === workspaceRoot || resolved.startsWith(rootWithSep))) {
		throw new Error(`Path escapes sandbox workspace: ${userPath}`)
	}
	return resolved
}

export async function ensureWorkspace(ctx: WorkspaceContext): Promise<string> {
	const root = resolveWorkspaceRoot(ctx)
	await mkdir(root, { recursive: true })
	return root
}
