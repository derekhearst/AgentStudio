import { getActiveGithubConnection, getRepositoryById } from './source-control.server'
import { materializeRepoMirror } from './repo-mirror.server'
import type { WorktreeConfig } from '$lib/workspace/workspace.server'

/**
 * Wave 5 #19 phase 2 finish — repo-backed task workspace provisioning.
 *
 * Composes the existing primitives (mirror materialization + worktree config) into a
 * single call the task runner uses when `task.repositoryId` is set:
 *
 *   1. Look up the repository row + verify it belongs to the user.
 *   2. Fetch the user's active GitHub OAuth token (private repos require auth).
 *   3. Materialize the repo's local mirror at `${SANDBOX_WORKSPACE}/<userId>/repos/<owner>/<repo>`
 *      (cloning if absent, fetching if present — same idempotent helper that backs the
 *      `clone_repository` agent tool).
 *   4. Compute the per-task branch: `agent/<taskId>/attempt-<N>` so retries get fresh
 *      branches and the chain is auditable from the GitHub side.
 *   5. Return a `WorktreeConfig` ready to drop into the runtime's existing worktree-mode
 *      workspace pipeline (`ensureWorkspace`/`ensureWorktree`).
 *
 * Throws on any failure (no mirror = no run). The runner catches and falls back to the
 * agent's existing workspace config so a misconfigured repo link doesn't strand the task
 * — the caller decides whether to mark the task `failed` or proceed without the repo.
 */

export type ProvisionRepoBackedWorkspaceInput = {
	userId: string
	taskId: string
	attemptNumber: number
	repositoryId: string
}

export type ProvisionRepoBackedWorkspaceResult = {
	worktree: WorktreeConfig
	mirrorPath: string
	branch: string
	repository: { id: string; owner: string; name: string; defaultBranch: string }
}

/**
 * Pure helper exposed for tests + the future "preview branch name" UI on the task page.
 * First attempt → `agent/<taskId>` (clean shape for the common case); retries get the
 * `attempt-N` suffix so the branch chain is greppable.
 */
export function buildTaskBranchName(taskId: string, attemptNumber: number): string {
	if (attemptNumber <= 1) return `agent/${taskId}`
	return `agent/${taskId}/attempt-${attemptNumber}`
}

export async function provisionRepoBackedWorkspace(
	input: ProvisionRepoBackedWorkspaceInput,
): Promise<ProvisionRepoBackedWorkspaceResult> {
	const repo = await getRepositoryById(input.repositoryId)
	if (!repo) {
		throw new Error(`Repository ${input.repositoryId} not found`)
	}
	if (repo.userId !== input.userId) {
		throw new Error(`Repository ${input.repositoryId} does not belong to user ${input.userId}`)
	}

	const conn = await getActiveGithubConnection(input.userId)
	if (!conn) {
		throw new Error(
			'No active GitHub connection for this user — connect at /source-control before running a repo-backed task.',
		)
	}

	const sandboxRoot = process.env.SANDBOX_WORKSPACE || '/workspace/users'
	// Mirror lives one level up from the per-attempt worktree, so the worktree at
	// ${sandbox}/<userId>/worktrees/<runId> can checkout against ${sandbox}/<userId>/repos/<owner>/<repo>.
	const mirrorRoot = `${sandboxRoot}/${input.userId}/repos`
	const mirror = await materializeRepoMirror({
		mirrorRoot,
		owner: repo.owner,
		repo: repo.name,
		token: conn.accessToken,
		defaultBranch: repo.defaultBranch,
	})

	const branch = buildTaskBranchName(input.taskId, input.attemptNumber)

	return {
		worktree: {
			repoPath: mirror.path,
			baseBranch: repo.defaultBranch,
			branch,
			deleteBranchOnCleanup: false,
		},
		mirrorPath: mirror.path,
		branch,
		repository: {
			id: repo.id,
			owner: repo.owner,
			name: repo.name,
			defaultBranch: repo.defaultBranch,
		},
	}
}
