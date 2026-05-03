import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { env } from '$env/dynamic/private'
import { ensureWorkspace, safePathWithin } from '$lib/workspace/workspace.server'
import { trimWithOffload, type OffloadHandle, type TrimWithOffloadInput } from './output-offload'

export type ServerTrimInput = Omit<TrimWithOffloadInput, 'offload'> & {
	userId: string
	runId: string
	persistentKey?: string | null
	worktree?: { repoPath: string; baseBranch?: string } | null
}

/**
 * Server-side wrapper around `trimWithOffload`. Persists the full payload to
 * `<workspace>/.tool-outputs/<callId>.txt` inside the resolved per-run workspace so the model
 * can recover it via `file_read('.tool-outputs/<callId>.txt')` after enabling the sandbox group.
 *
 * No-op offload when the content fits the per-tool limit (the file is never created in the
 * common small-output path).
 */
export async function trimToolResultWithOffload(input: ServerTrimInput): Promise<{
	visible: string
	offloaded: boolean
	handle: OffloadHandle | null
	fullSize: number
}> {
	const result = await trimWithOffload({
		toolName: input.toolName,
		content: input.content,
		callId: input.callId,
		offload: async (handle, fullContent) => {
			await materializeOutput(
				{
					userId: input.userId,
					runId: input.runId,
					persistentKey: input.persistentKey,
					worktree: input.worktree,
				},
				handle,
				fullContent,
			)
		},
	})
	return { visible: result.visible, offloaded: result.offloaded, handle: result.handle, fullSize: result.fullSize }
}

async function materializeOutput(
	ctx: {
		userId: string
		runId: string
		persistentKey?: string | null
		worktree?: { repoPath: string; baseBranch?: string } | null
	},
	handle: OffloadHandle,
	fullContent: string,
) {
	const workspaceRoot = await ensureWorkspace({
		userId: ctx.userId,
		runId: ctx.runId,
		persistentKey: ctx.persistentKey ?? null,
		worktree: ctx.worktree ?? null,
		sandboxRoot: env.SANDBOX_WORKSPACE,
	})
	const fullPath = safePathWithin(workspaceRoot, handle)
	await mkdir(dirname(fullPath), { recursive: true })
	await writeFile(fullPath, fullContent, 'utf-8')
	return resolve(fullPath)
}
