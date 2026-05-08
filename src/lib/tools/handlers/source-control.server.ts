/**
 * Source-control + git-inspection tool handlers.
 *
 * Includes everything that touches the source-control domain (list/sync repos, push
 * branch, open PR, list/get PRs, clone repository, prepare commit) plus the read-only
 * git-inspection tools (git_status, git_log, git_diff) that work in worktree mode.
 *
 * `push_branch` and `create_pull_request` defend in depth: they refuse if the run has
 * no `chat_stream` source — automation/sub-agent runs cannot pause for operator
 * approval, so even with a misconfigured runtime these tools fail closed.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { toolSchemas } from '../tool-schemas'
import { ensureWorkspaceDir, getWorkspace, safePath, toolUserContext } from '../sandbox.server'
import { logger } from '$lib/observability/logger'
import type { ToolHandler } from '../handler-types'

const execFileAsync = promisify(execFile)

export const sourceControlHandlers: Record<string, ToolHandler> = {
	list_my_repos: async (call, { userId, startedAt }) => {
		const input = toolSchemas.list_my_repos.parse(call.arguments)
		const sourceControl = await import('$lib/source-control')
		const repos = await sourceControl.listImportedRepositories(userId)
		const filter = input.search?.toLowerCase() ?? null
		const filtered = filter
			? repos.filter(
					(r) => r.owner.toLowerCase().includes(filter) || r.name.toLowerCase().includes(filter),
				)
			: repos
		const limited = filtered.slice(0, input.limit ?? 50)
		return {
			success: true,
			tool: call.name,
			input,
			result: limited.map((r) => {
				const meta = (r.metadata ?? {}) as { htmlUrl?: string; private?: boolean; description?: string | null }
				return {
					id: r.id,
					provider: r.provider,
					owner: r.owner,
					name: r.name,
					defaultBranch: r.defaultBranch,
					cloneUrl: r.cloneUrl,
					htmlUrl: meta.htmlUrl ?? null,
					private: !!meta.private,
					description: meta.description ?? null,
					updatedAt: r.updatedAt,
				}
			}),
			executionMs: Date.now() - startedAt,
		}
	},

	sync_my_repos: async (call, { userId, startedAt }) => {
		const input = toolSchemas.sync_my_repos.parse(call.arguments)
		const sourceControl = await import('$lib/source-control')
		const summary = await sourceControl.syncGithubReposForUser(userId, input)
		if (summary.errorMessage) {
			return {
				success: false,
				tool: call.name,
				error: summary.errorMessage,
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: {
				total: summary.total,
				inserted: summary.inserted,
				updated: summary.updated,
				skipped: summary.skipped,
			},
			executionMs: Date.now() - startedAt,
		}
	},

	push_branch: async (call, { userId, startedAt }) => {
		const surfaceCheck = await assertInteractiveChatSurface(call.name)
		if (surfaceCheck) return { ...surfaceCheck, executionMs: Date.now() - startedAt }

		const sourceControl = await import('$lib/source-control')
		const conn = await sourceControl.getActiveGithubConnection(userId)
		if (!conn) {
			return {
				success: false,
				tool: call.name,
				error: 'No active GitHub connection. Connect at /source-control before pushing or opening pull requests.',
				executionMs: Date.now() - startedAt,
			}
		}

		const input = toolSchemas.push_branch.parse(call.arguments)
		const absPath = safePath(input.path ?? '.')
		try {
			let branch = input.branch
			if (!branch) {
				const { defaultGitRunner } = await import('$lib/workspace/worktree.server')
				const headResult = await defaultGitRunner(['-C', absPath, 'symbolic-ref', '--short', 'HEAD'])
				if (headResult.code !== 0) {
					return {
						success: false,
						tool: call.name,
						error: `Could not detect current branch (${headResult.stderr.trim() || 'detached HEAD?'}). Pass an explicit branch.`,
						executionMs: Date.now() - startedAt,
					}
				}
				branch = headResult.stdout.trim()
			}
			const { pushBranchToGithub } = await import('$lib/source-control/git-push.server')
			const pushResult = await pushBranchToGithub({
				repoPath: absPath,
				owner: input.owner,
				repo: input.repo,
				branch,
				token: conn.accessToken,
				force: input.force ?? false,
			})
			if (!pushResult.success) {
				return {
					success: false,
					tool: call.name,
					input: { ...input, branch },
					error: `git push failed (exit ${pushResult.exitCode}): ${pushResult.stderr.trim() || pushResult.stdout.trim()}`,
					executionMs: Date.now() - startedAt,
				}
			}
			return {
				success: true,
				tool: call.name,
				input: { ...input, branch },
				result: {
					branch: pushResult.branch,
					remote: pushResult.remote,
					stdout: pushResult.stdout,
					stderr: pushResult.stderr,
				},
				executionMs: Date.now() - startedAt,
			}
		} catch (err) {
			return {
				success: false,
				tool: call.name,
				error: err instanceof Error ? err.message : String(err),
				executionMs: Date.now() - startedAt,
			}
		}
	},

	create_pull_request: async (call, { userId, startedAt }) => {
		const surfaceCheck = await assertInteractiveChatSurface(call.name)
		if (surfaceCheck) return { ...surfaceCheck, executionMs: Date.now() - startedAt }

		const sourceControl = await import('$lib/source-control')
		const conn = await sourceControl.getActiveGithubConnection(userId)
		if (!conn) {
			return {
				success: false,
				tool: call.name,
				error: 'No active GitHub connection. Connect at /source-control before pushing or opening pull requests.',
				executionMs: Date.now() - startedAt,
			}
		}

		const input = toolSchemas.create_pull_request.parse(call.arguments)
		try {
			const { createPullRequest } = await import('$lib/source-control/github-api.server')
			const pr = await createPullRequest(conn.accessToken, {
				owner: input.owner,
				repo: input.repo,
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
				draft: input.draft ?? true,
			})
			// Persist the PR to source-control schema if we have an attached repo row.
			let recordedId: string | null = null
			try {
				const repos = await sourceControl.listRepositories(userId)
				const matched = repos.find(
					(r) => r.owner.toLowerCase() === input.owner.toLowerCase() && r.name.toLowerCase() === input.repo.toLowerCase(),
				)
				if (matched) {
					const recorded = await sourceControl.recordPullRequest({
						repositoryId: matched.id,
						providerPrNumber: pr.number,
						title: input.title,
						body: input.body ?? null,
						headBranch: input.head,
						baseBranch: input.base,
						status: pr.draft ? 'draft' : pr.state === 'closed' ? 'closed' : 'open',
						runId: toolUserContext.getStore()?.runId ?? null,
						createdBy: userId,
						providerUrl: pr.htmlUrl,
						metadata: { source: 'agent' },
					})
					recordedId = recorded.id
				}
			} catch (err) {
				logger.warn('[create_pull_request] recordPullRequest failed (non-fatal)', { err })
			}
			// Wave 5 #19 phase 4 — review-inbox handoff. Best-effort: a failed insert
			// never blocks the agent's report-back to the user. DedupeKey ensures a single
			// open row per (owner, repo, prNumber) even if the agent retries.
			void (async () => {
				try {
					const { openReviewItem } = await import('$lib/observability/review.server')
					await openReviewItem({
						type: 'pull_request_ready',
						severity: 'info',
						summary: `PR opened: ${input.owner}/${input.repo}#${pr.number} — ${input.title.slice(0, 120)}`,
						payload: {
							kind: 'pull_request',
							owner: input.owner,
							repo: input.repo,
							prNumber: pr.number,
							htmlUrl: pr.htmlUrl,
							draft: pr.draft,
							head: input.head,
							base: input.base,
							recordedId,
							userId,
						},
						runId: toolUserContext.getStore()?.runId ?? null,
						dedupeKey: `pull_request:${input.owner}/${input.repo}:${pr.number}`,
					})
				} catch (err) {
					logger.warn('[create_pull_request] review-inbox handoff failed (non-fatal)', { err })
				}
			})()
			return {
				success: true,
				tool: call.name,
				input,
				result: {
					number: pr.number,
					htmlUrl: pr.htmlUrl,
					state: pr.state,
					draft: pr.draft,
					recordedId,
				},
				executionMs: Date.now() - startedAt,
			}
		} catch (err) {
			return {
				success: false,
				tool: call.name,
				input,
				error: err instanceof Error ? err.message : String(err),
				executionMs: Date.now() - startedAt,
			}
		}
	},

	list_pull_requests: async (call, { userId, startedAt }) => {
		const input = toolSchemas.list_pull_requests.parse(call.arguments)
		const sourceControl = await import('$lib/source-control')
		const repos = await sourceControl.listRepositories(userId)
		const matched = repos.find(
			(r) => r.owner.toLowerCase() === input.owner.toLowerCase() && r.name.toLowerCase() === input.repo.toLowerCase(),
		)
		if (!matched) {
			return {
				success: false,
				tool: call.name,
				input,
				error: `Repository ${input.owner}/${input.repo} is not synced for this user. Run sync_my_repos first.`,
				executionMs: Date.now() - startedAt,
			}
		}
		const prs = await sourceControl.listPullRequestsForRepository(matched.id)
		const limit = input.limit ?? 50
		return {
			success: true,
			tool: call.name,
			input,
			result: prs.slice(0, limit).map((pr) => ({
				id: pr.id,
				providerPrNumber: pr.providerPrNumber,
				title: pr.title,
				status: pr.status,
				headBranch: pr.headBranch,
				baseBranch: pr.baseBranch,
				providerUrl: pr.providerUrl,
				runId: pr.runId,
				createdBy: pr.createdBy,
				createdAt: pr.createdAt,
				updatedAt: pr.updatedAt,
			})),
			executionMs: Date.now() - startedAt,
		}
	},

	get_pull_request: async (call, { userId, startedAt }) => {
		const input = toolSchemas.get_pull_request.parse(call.arguments)
		const sourceControl = await import('$lib/source-control')
		const pr = await sourceControl.getPullRequestById(input.pullRequestId)
		if (!pr) {
			return {
				success: true,
				tool: call.name,
				input,
				result: null,
				executionMs: Date.now() - startedAt,
			}
		}
		// Authorization check: the PR must belong to a repo the user owns.
		const repos = await sourceControl.listRepositories(userId)
		const owns = repos.some((r) => r.id === pr.repositoryId)
		if (!owns) {
			return {
				success: false,
				tool: call.name,
				input,
				error: `Pull request ${input.pullRequestId} is not visible to this user.`,
				executionMs: Date.now() - startedAt,
			}
		}
		return {
			success: true,
			tool: call.name,
			input,
			result: pr,
			executionMs: Date.now() - startedAt,
		}
	},

	clone_repository: async (call, { userId, startedAt }) => {
		const input = toolSchemas.clone_repository.parse(call.arguments)
		const sourceControl = await import('$lib/source-control')
		const owns = (await sourceControl.listRepositories(userId)).find(
			(r) => r.owner.toLowerCase() === input.owner.toLowerCase() && r.name.toLowerCase() === input.repo.toLowerCase(),
		)
		if (!owns) {
			return {
				success: false,
				tool: call.name,
				input,
				error: `Repository ${input.owner}/${input.repo} is not connected for this user. Run sync_my_repos first.`,
				executionMs: Date.now() - startedAt,
			}
		}
		const conn = await sourceControl.getActiveGithubConnection(userId)
		if (!conn) {
			return {
				success: false,
				tool: call.name,
				input,
				error: 'No active GitHub connection. Connect at /source-control before cloning private repos.',
				executionMs: Date.now() - startedAt,
			}
		}
		const workspaceRoot = getWorkspace()
		// Mirror lives at `${workspace}/repos/<owner>/<repo>` so cleanup of the per-user
		// sandbox sweeps mirrors too. The path is bounded by safePathWithin so a hostile
		// owner/repo string cannot escape the workspace root even if it bypassed the
		// SAFE_SEGMENT regex (defense in depth).
		const mirrorRoot = safePath('repos')
		try {
			const { materializeRepoMirror } = await import('$lib/source-control/repo-mirror.server')
			const result = await materializeRepoMirror({
				mirrorRoot,
				owner: input.owner,
				repo: input.repo,
				defaultBranch: owns.defaultBranch,
				token: conn.accessToken,
			})
			return {
				success: true,
				tool: call.name,
				input,
				result: {
					path: result.path,
					fresh: result.fresh,
					branch: result.branch,
					workspaceRoot,
				},
				executionMs: Date.now() - startedAt,
			}
		} catch (err) {
			return {
				success: false,
				tool: call.name,
				input,
				error: err instanceof Error ? err.message : String(err),
				executionMs: Date.now() - startedAt,
			}
		}
	},

	prepare_commit: async (call, { startedAt }) => {
		const input = toolSchemas.prepare_commit.parse(call.arguments)
		const absPath = safePath(input.path ?? '.')
		const { prepareCommitDraft } = await import('$lib/source-control/git-local.server')
		try {
			const draft = await prepareCommitDraft(absPath)
			return {
				success: true,
				tool: call.name,
				input,
				result: draft,
				executionMs: Date.now() - startedAt,
			}
		} catch (err) {
			return {
				success: false,
				tool: call.name,
				input,
				error: err instanceof Error ? err.message : String(err),
				executionMs: Date.now() - startedAt,
			}
		}
	},

	git_status: gitInspectHandler('git_status'),
	git_log: gitInspectHandler('git_log'),
	git_diff: gitInspectHandler('git_diff'),
}

/**
 * push_branch / create_pull_request defense-in-depth: refuse the call if the run
 * source isn't `chat_stream` (i.e. there's no operator on the other side to approve
 * the destructive action). Returns a partial error result on refusal, null on pass.
 */
async function assertInteractiveChatSurface(toolName: string): Promise<{
	success: false
	tool: string
	error: string
} | null> {
	const ctx = toolUserContext.getStore()
	if (!ctx?.runId) {
		return {
			success: false,
			tool: toolName,
			error: `${toolName} requires an interactive chat run with an operator; this call has no run context.`,
		}
	}
	try {
		const { chatRuns } = await import('$lib/runs/runs.schema')
		const [runRow] = await db
			.select({ source: chatRuns.source })
			.from(chatRuns)
			.where(eq(chatRuns.id, ctx.runId))
			.limit(1)
		if (!runRow) {
			return {
				success: false,
				tool: toolName,
				error: `${toolName}: run not found.`,
			}
		}
		if (runRow.source !== 'chat_stream') {
			return {
				success: false,
				tool: toolName,
				error: `${toolName} cannot run in a ${runRow.source} context. It requires operator approval through an interactive chat run.`,
			}
		}
	} catch (err) {
		return {
			success: false,
			tool: toolName,
			error: `${toolName}: failed to verify approval surface (${err instanceof Error ? err.message : String(err)})`,
		}
	}
	return null
}

/**
 * Build a handler for one of the read-only git inspection tools. They share workspace
 * setup + error-shaping; only the argv differs.
 */
function gitInspectHandler(name: 'git_status' | 'git_log' | 'git_diff'): ToolHandler {
	return async (call, { startedAt }) => {
		const ctx = toolUserContext.getStore()
		if (!ctx?.worktree) {
			return {
				success: false,
				tool: call.name,
				error: `${call.name} is only available in a git-worktree workspace (configure agent.config.workspace.mode='worktree' with a repoPath).`,
				executionMs: Date.now() - startedAt,
			}
		}
		await ensureWorkspaceDir()
		const workspace = getWorkspace()
		try {
			if (name === 'git_status') {
				const result = await execFileAsync(
					'git',
					['-C', workspace, 'status', '--porcelain=v1', '-b'],
					{ maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
				)
				return {
					success: true,
					tool: call.name,
					input: {},
					result: { stdout: result.stdout, stderr: result.stderr },
					executionMs: Date.now() - startedAt,
				}
			}
			if (name === 'git_log') {
				const input = toolSchemas.git_log.parse(call.arguments)
				const args = [
					'-C',
					workspace,
					'log',
					`--max-count=${input.max}`,
					'--pretty=format:%h%x09%an%x09%ad%x09%s',
					'--date=short',
				]
				if (input.paths?.length) {
					args.push('--')
					for (const p of input.paths) args.push(safePath(p))
				}
				const result = await execFileAsync('git', args, {
					maxBuffer: 4 * 1024 * 1024,
					timeout: 30_000,
				})
				return {
					success: true,
					tool: call.name,
					input,
					result: { stdout: result.stdout, stderr: result.stderr },
					executionMs: Date.now() - startedAt,
				}
			}
			// git_diff
			const input = toolSchemas.git_diff.parse(call.arguments)
			const args = ['-C', workspace, 'diff']
			if (input.staged) args.push('--cached')
			if (input.ref) args.push(input.ref)
			if (input.paths?.length) {
				args.push('--')
				for (const p of input.paths) args.push(safePath(p))
			}
			const result = await execFileAsync('git', args, {
				maxBuffer: 8 * 1024 * 1024,
				timeout: 60_000,
			})
			return {
				success: true,
				tool: call.name,
				input,
				result: { stdout: result.stdout, stderr: result.stderr },
				executionMs: Date.now() - startedAt,
			}
		} catch (err: unknown) {
			const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
			return {
				success: false,
				tool: call.name,
				error: e.stderr ?? e.message ?? `${call.name} failed`,
				executionMs: Date.now() - startedAt,
			}
		}
	}
}
