import { desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
import { conversations } from '$lib/sessions/sessions.schema'
import { chatRuns } from '$lib/runs/runs.schema'
import { insertMessageWithSequence } from '$lib/chat/insert-message.server'
import { logger } from '$lib/observability/logger'
import { buildFixPrompt } from './pr-checks'
import { mayFixPullRequest } from './pr-fix'
import { pullRequestChecks, pullRequests, repositories } from './source-control.schema'

/**
 * #20 — the "fix it" path.
 *
 * A review item saying CI is red is only half useful; the other half is being able to hand
 * the failure straight back to the agent that caused it, WITH the context it already has.
 * `pull_requests.runId` exists precisely for this: it points at the run that opened the
 * PR, which points at the conversation the operator was in when they asked for the work.
 * Seeding the failure into that conversation means the agent still has the branch, the
 * plan, and the reasoning that produced the code — rather than starting cold in a new
 * thread and rediscovering all of it.
 *
 * This is explicitly operator-initiated. CI failing is not, on its own, a reason to spend
 * money running an agent: half of red CI is a flake, an outage, or a pre-existing failure
 * on the base branch. The review item offers the button; a human presses it.
 *
 * Falls back to a fresh conversation when the originating one is gone (run deleted, chat
 * pruned, PR recorded out-of-band with no run). A degraded fix run beats refusing to help.
 */

export type StartPullRequestFixResult = {
	pullRequestId: string
	conversationId: string
	runId: string
	/** True when we had to open a new conversation instead of resuming the original. */
	seededNewConversation: boolean
	ok: boolean
	error?: string
}

/**
 * The pull request, if `userId` may start a fix run on it. Null for a missing PR and for
 * someone else's alike. The command asks before it queues; the job asks again, because it
 * runs later and has no request user to lean on.
 */
export async function findPullRequestForFix(userId: string, pullRequestId: string): Promise<{ id: string } | null> {
	const [row] = await db
		.select({ id: pullRequests.id, repositoryUserId: repositories.userId })
		.from(pullRequests)
		.innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
		.where(eq(pullRequests.id, pullRequestId))
		.limit(1)
	if (!row || !mayFixPullRequest(row.repositoryUserId, userId)) return null
	return { id: row.id }
}

export async function startPullRequestFixRun(input: {
	pullRequestId: string
	userId: string
	checkName?: string | null
	reviewItemId?: string | null
	now?: Date
}): Promise<StartPullRequestFixResult> {
	const now = input.now ?? new Date()

	const [row] = await db
		.select({ pr: pullRequests, repo: repositories })
		.from(pullRequests)
		.innerJoin(repositories, eq(pullRequests.repositoryId, repositories.id))
		.where(eq(pullRequests.id, input.pullRequestId))
		.limit(1)
	if (!row) throw new Error(`Pull request ${input.pullRequestId} not found`)
	const { pr, repo } = row

	// Ownership is checked here rather than only at the remote-function boundary, because
	// this also runs from the job queue where there is no request user to lean on.
	if (!mayFixPullRequest(repo.userId, input.userId)) {
		throw new Error('Pull request belongs to another user')
	}

	const failing = await resolveFailingCheck(pr.id, input.checkName ?? null)
	if (!failing) {
		throw new Error('No failing check recorded for this pull request — nothing to fix')
	}
	const meta = (failing.metadata ?? {}) as {
		headSha?: string | null
		logExcerpt?: string | null
		outputSummary?: string | null
	}

	const prompt = buildFixPrompt({
		owner: repo.owner,
		repo: repo.name,
		prNumber: pr.providerPrNumber,
		checkName: failing.checkName,
		prTitle: pr.title,
		headBranch: pr.headBranch,
		prUrl: pr.providerUrl,
		detailsUrl: failing.detailsUrl,
		headSha: meta.headSha ?? null,
		summary: meta.outputSummary ?? null,
		logExcerpt: meta.logExcerpt ?? null,
	})

	const target = await resolveTargetConversation({ pr, repoOwnerUserId: input.userId, title: `Fix CI: ${repo.owner}/${repo.name}#${pr.providerPrNumber}` })

	await insertMessageWithSequence({
		conversationId: target.conversationId,
		role: 'user',
		content: prompt,
		model: target.model,
	})

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: target.conversationId,
			userId: input.userId,
			agentId: target.agentId,
			state: 'running',
			// The existing enum value for "scheduled / non-interactive"; the label says where
			// it actually came from.
			source: 'automation',
			label: `CI fix: ${failing.checkName.slice(0, 60)} on #${pr.providerPrNumber}`,
			startedAt: now,
			lastHeartbeatAt: now,
		})
		.returning({ id: chatRuns.id })

	const base: StartPullRequestFixResult = {
		pullRequestId: pr.id,
		conversationId: target.conversationId,
		runId: run.id,
		seededNewConversation: target.seededNewConversation,
		ok: true,
	}

	try {
		await runFixLoop({
			userId: input.userId,
			agentId: target.agentId,
			conversationId: target.conversationId,
			model: target.model,
			prompt,
			runId: run.id,
		})
		return base
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		logger.warn('[pr-fix] fix run failed', { pullRequestId: pr.id, error: message })
		// The seeded message survives in the conversation, so the operator can open it and
		// carry on by hand even though the detached loop died.
		return { ...base, ok: false, error: message }
	}
}

/**
 * Which check are we fixing? An explicit name wins. Otherwise take the most recently
 * updated failing check — with several red, the newest is the one the operator was just
 * looking at.
 */
async function resolveFailingCheck(pullRequestId: string, checkName: string | null) {
	// One query, filtered in JS: a PR has a handful of checks, and this way an explicit
	// name that no longer exists degrades to "the newest failure" instead of an error.
	const rows = await db
		.select()
		.from(pullRequestChecks)
		.where(eq(pullRequestChecks.pullRequestId, pullRequestId))
		.orderBy(desc(pullRequestChecks.updatedAt))
	if (checkName) {
		const exact = rows.find((r) => r.checkName === checkName)
		if (exact) return exact
	}
	return rows.find((r) => r.status === 'failure') ?? null
}

/**
 * Resume the originating conversation when we can still reach it, open a new one when we
 * cannot. Reaching it is a two-hop walk: PR → run → conversation.
 */
async function resolveTargetConversation(input: {
	pr: typeof pullRequests.$inferSelect
	repoOwnerUserId: string
	title: string
}): Promise<{ conversationId: string; agentId: string; model: string; seededNewConversation: boolean }> {
	if (input.pr.runId) {
		const [existing] = await db
			.select({
				conversationId: conversations.id,
				agentId: conversations.agentId,
				model: conversations.model,
			})
			.from(chatRuns)
			.innerJoin(conversations, eq(chatRuns.conversationId, conversations.id))
			.where(eq(chatRuns.id, input.pr.runId))
			.limit(1)
		if (existing?.conversationId) {
			const agentId = existing.agentId ?? (await requireDefaultAgentId(input.repoOwnerUserId, null))
			return {
				conversationId: existing.conversationId,
				agentId,
				model: existing.model,
				seededNewConversation: false,
			}
		}
	}

	const agentId = await requireDefaultAgentId(input.repoOwnerUserId, null)
	const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
	const { getOrCreateSettings } = await import('$lib/settings/settings.server')
	const settings = await getOrCreateSettings(input.repoOwnerUserId)
	const model = agent?.model ?? settings.defaultModel

	const [conversation] = await db
		.insert(conversations)
		.values({
			title: input.title.slice(0, 200),
			userId: input.repoOwnerUserId,
			agentId,
			model,
		})
		.returning({ id: conversations.id })

	return { conversationId: conversation.id, agentId, model, seededNewConversation: true }
}

async function requireDefaultAgentId(userId: string, preferred: string | null): Promise<string> {
	const { resolveDefaultAgentId } = await import('$lib/chat/agent-switch.server')
	const agentId = await resolveDefaultAgentId(userId, preferred)
	if (!agentId) {
		throw new Error('no default agent configured — re-run database bootstrap to seed built-in agents')
	}
	return agentId
}

/**
 * Run the agent detached. Nobody is streaming this — the operator pressed a button in
 * /review and will come back to the conversation — so the loop is bounded and no tool
 * needs an interactive approval surface. `push_branch` and `create_pull_request` already
 * refuse non-`chat_stream` runs of their own accord, so a fix run can diagnose and edit
 * but cannot silently push over the operator's branch; that last step stays a human's.
 */
async function runFixLoop(input: {
	userId: string
	agentId: string
	conversationId: string
	model: string
	prompt: string
	runId: string
}): Promise<void> {
	const [agent] = await db.select().from(agents).where(eq(agents.id, input.agentId)).limit(1)
	if (!agent) throw new Error(`agent ${input.agentId} not found`)

	const { buildAgentDefinition, createDetachedSession, runChatLoop } = await import('$lib/runtime')
	const definition = await buildAgentDefinition({
		agent,
		userId: input.userId,
		intent: input.prompt,
		toolPolicy: [
			'CI fix policy:',
			'- A continuous-integration check failed on a pull request you opened; no user is watching in real time.',
			'- Diagnose before editing. Say what broke and why before you change a line.',
			'- If the failure is unrelated to this branch, report that and stop rather than rewriting working code.',
			'- Do not push or re-open the pull request yourself; summarize the fix and leave the push to the operator.',
		].join('\n'),
	})

	const [conversation] = await db
		.select({ projectId: conversations.projectId })
		.from(conversations)
		.where(eq(conversations.id, input.conversationId))
		.limit(1)

	const session = createDetachedSession({ runId: input.runId })
	try {
		const loopResult = await runChatLoop({
			session,
			userId: input.userId,
			conversationId: input.conversationId,
			model: input.model,
			initialMessages: [
				{ role: 'system', content: definition.systemPrompt },
				{ role: 'user', content: input.prompt },
			],
			initialTools: definition.tools,
			computeTools: async () => definition.tools,
			maxRounds: 12,
			approvalRequiredTools: new Set<string>(),
			isOrchestrator: false,
			agentId: agent.id,
			persistentKey: definition.persistentKey,
			worktree: definition.worktree,
			projectId: conversation?.projectId ?? null,
			spawnSubagent: undefined,
		})

		const { logLlmUsage } = await import('$lib/costs/usage')
		const cost = await logLlmUsage({
			source: 'automation',
			model: input.model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			userId: input.userId,
			runId: input.runId,
			agentId: agent.id,
			metadata: { kind: 'pr_fix', conversationId: input.conversationId },
		}).catch(() => '0')

		await insertMessageWithSequence({
			conversationId: input.conversationId,
			role: 'assistant',
			content: loopResult.finalText || '(no output)',
			model: input.model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			cost,
			toolCalls: loopResult.toolCalls,
			metadata: {
				blocks: loopResult.streamBlocks.length > 0 ? loopResult.streamBlocks : undefined,
				runId: input.runId,
				kind: 'pr_fix',
			},
		})

		await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, input.conversationId))
		await session.updateRun({
			state: 'completed',
			label: 'CI fix run completed',
			lastDelta: loopResult.finalText.slice(-500),
			heartbeat: true,
			finished: true,
		})
	} catch (err) {
		await session
			.updateRun({
				state: 'failed',
				label: 'CI fix run failed',
				error: err instanceof Error ? err.message : 'CI fix run failed',
				finished: true,
			})
			.catch(() => undefined)
		throw err
	}
}
