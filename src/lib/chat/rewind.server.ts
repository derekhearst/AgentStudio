/**
 * #24 — restore a conversation's files to how they were at one of its user messages.
 *
 * The edit/regenerate flow calls these: `previewMessageRewind` for the dialog, then
 * `applyMessageRewind` when the user confirms, before any row changes. Both go through a
 * short-lived control session (`$lib/engine/rewind.server`), so they work after a restart
 * and cost no model call.
 *
 * The guards, all checked on every call rather than trusted from the preview:
 *
 * - the message is the caller's own, a user row, with a checkpointed join (`./turn-plan`);
 * - its checkpoint belongs to the conversation's current SDK session — an older session's
 *   file history knows nothing about what later sessions changed;
 * - the working directory it recorded is inside the caller's own sandbox, and still there;
 * - no turn is running in the conversation, and no other rewind is (one per conversation,
 *   in this process — the session file and the workspace are shared);
 * - nothing outside the workspace is touched;
 * - an imported repository with uncommitted changes in the files being restored needs
 *   `acknowledgeUncommitted`, because git cannot bring those back.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { projects, type RepoKind } from '$lib/projects/projects.schema'
import { getProjectPath } from '$lib/projects/project-fs.server'
import { defaultGitRunner } from '$lib/workspace/worktree.server'
import { findLiveChatRun } from '$lib/runs/live-chat-run.server'
import { resolveWorkspaceRoot } from '$lib/workspace/workspace.server'
import { isPathWithin } from '$lib/workspace/containment.server'
import { withControlSession, type CreateRewindQuery, type RewindControl } from '$lib/engine/rewind.server'
import { logger } from '$lib/observability/logger'
import { readTurnJoin, type TurnJoin } from './turn-plan'
import { mapRewindPreview, parseUncommittedPaths, uncommittedStatusArgs } from './rewind-plan'
import { blockedPreview, unavailablePreview, type RewindPreview } from './rewind-preview'

/** Conversations with a rewind in flight in this process. */
const rewinding = new Set<string>()

/** Whether a rewind is restoring this conversation's files right now. A new turn must wait. */
export function isConversationRewinding(conversationId: string): boolean {
	return rewinding.has(conversationId)
}

export type RewindDeps = {
	/** The SDK seam, for specs. */
	createQuery?: CreateRewindQuery
	/** Workspace-relative paths with uncommitted changes, or null when `repoPath` is not a checkout. */
	uncommittedPaths?: (repoPath: string) => Promise<Set<string> | null>
	/** The per-user sandbox root. Defaults to `SANDBOX_WORKSPACE`, as runs use. */
	sandboxRoot?: string
	timeoutMs?: number
}

type RewindTarget = {
	conversationId: string
	join: TurnJoin
	repoKind: RepoKind | null
	/** The project checkout, when the run stood in it: where `git status` is asked. */
	gitRoot: string | null
}

async function defaultUncommittedPaths(repoPath: string): Promise<Set<string> | null> {
	try {
		const result = await defaultGitRunner(uncommittedStatusArgs(repoPath))
		// Not a checkout, or git failed: say nothing rather than guess.
		return result.code === 0 ? parseUncommittedPaths(result.stdout) : null
	} catch {
		return null
	}
}

/** Resolve the message to rewind to, or the preview that explains why there is nothing to do. */
async function loadTarget(
	userId: string,
	messageId: string,
	deps: RewindDeps,
): Promise<{ ok: true; target: RewindTarget } | { ok: false; preview: RewindPreview }> {
	const [row] = await db
		.select({
			role: messages.role,
			metadata: messages.metadata,
			conversationId: messages.conversationId,
			sdkSessionId: conversations.sdkSessionId,
			projectId: conversations.projectId,
		})
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(and(eq(messages.id, messageId), eq(conversations.userId, userId)))
		.limit(1)
	if (!row || row.role !== 'user') return { ok: false, preview: unavailablePreview() }

	const join = readTurnJoin(row.metadata)
	if (!join || !join.checkpointed) return { ok: false, preview: unavailablePreview() }
	if (join.sessionId !== row.sdkSessionId) {
		return {
			ok: false,
			preview: unavailablePreview('This message is from an earlier session of this conversation, so its files cannot be restored.'),
		}
	}

	const sandboxRoot = deps.sandboxRoot ?? process.env.SANDBOX_WORKSPACE
	if (!isPathWithin(resolveWorkspaceRoot({ userId, sandboxRoot }), resolve(join.cwd))) {
		return { ok: false, preview: unavailablePreview() }
	}
	// A workspace that is gone has nothing left to restore into — and the CLI cannot start in it.
	if (!existsSync(join.cwd)) return { ok: false, preview: unavailablePreview() }

	let repoKind: RepoKind | null = null
	let gitRoot: string | null = null
	if (row.projectId) {
		const [project] = await db
			.select({ repoKind: projects.repoKind, repoLocalPath: projects.repoLocalPath })
			.from(projects)
			.where(and(eq(projects.id, row.projectId), eq(projects.userId, userId)))
			.limit(1)
		if (project) {
			const checkout = project.repoLocalPath ?? getProjectPath(userId, row.projectId)
			// Only when the run stood in the checkout: an agent's persistent directory is not the repo.
			if (resolve(checkout) === resolve(join.cwd)) {
				repoKind = project.repoKind
				gitRoot = project.repoKind === 'none' ? null : checkout
			}
		}
	}

	return { ok: true, target: { conversationId: row.conversationId, join, repoKind, gitRoot } }
}

/** A turn running in the conversation owns its session and its workspace. */
async function liveTurnReason(userId: string, target: RewindTarget): Promise<string | null> {
	if (await findLiveChatRun(target.conversationId, userId)) {
		return 'A reply is still being written. Wait for it to finish, or stop it, first.'
	}
	return null
}

/** The dry run, mapped. Needs an open control session. */
async function dryRun(control: RewindControl, target: RewindTarget, deps: RewindDeps): Promise<RewindPreview> {
	const result = await control.rewindFiles(target.join.uuid, { dryRun: true })
	const uncommitted = target.gitRoot ? await (deps.uncommittedPaths ?? defaultUncommittedPaths)(target.gitRoot) : null
	return mapRewindPreview({ result, workspaceRoot: target.join.cwd, uncommittedPaths: uncommitted, repoKind: target.repoKind })
}

class RewindBusyError extends Error {
	constructor() {
		super('Files are already being restored in this conversation.')
		this.name = 'RewindBusyError'
	}
}

/**
 * One rewind per conversation at a time. Claimed synchronously, before the first await, so
 * two requests cannot both see the conversation free.
 */
async function exclusively<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
	if (rewinding.has(conversationId)) throw new RewindBusyError()
	rewinding.add(conversationId)
	try {
		return await work()
	} finally {
		rewinding.delete(conversationId)
	}
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What restoring files to `messageId` would do. Changes nothing. */
export async function previewMessageRewind(
	input: { userId: string; messageId: string },
	deps: RewindDeps = {},
): Promise<RewindPreview> {
	const loaded = await loadTarget(input.userId, input.messageId, deps)
	if (!loaded.ok) return loaded.preview
	const { target } = loaded

	try {
		return await exclusively(target.conversationId, async () => {
			const busy = await liveTurnReason(input.userId, target)
			if (busy) return blockedPreview(busy, target.repoKind)
			return withControlSession(
				{ sessionId: target.join.sessionId, cwd: target.join.cwd, createQuery: deps.createQuery, timeoutMs: deps.timeoutMs },
				(control) => dryRun(control, target, deps),
			)
		})
	} catch (error) {
		if (error instanceof RewindBusyError) return blockedPreview(error.message, target.repoKind)
		logger.warn('[chat/rewind] preview failed', { messageId: input.messageId, error: describeError(error) })
		return blockedPreview(`Could not check the files: ${describeError(error)}`, target.repoKind)
	}
}

export type ApplyRewindResult =
	| {
			ok: true
			/** The previewed files, less the ones the CLI refused. */
			filesRestored: number
			/** Files left as they are because a link was in the way. The user is told. */
			skippedLinks: number
	  }
	| { ok: false; error: string }

/**
 * Restore the files to how they were at `messageId`.
 *
 * Runs the dry run again inside the same session first: the preview the user saw may be
 * minutes old, and every refusal is judged on what is on disk now.
 */
export async function applyMessageRewind(
	input: { userId: string; messageId: string; acknowledgeUncommitted?: boolean },
	deps: RewindDeps = {},
): Promise<ApplyRewindResult> {
	const loaded = await loadTarget(input.userId, input.messageId, deps)
	if (!loaded.ok) return { ok: false, error: loaded.preview.reason ?? 'This message has no saved files to restore.' }
	const { target } = loaded

	try {
		return await exclusively(target.conversationId, async (): Promise<ApplyRewindResult> => {
			const busy = await liveTurnReason(input.userId, target)
			if (busy) return { ok: false, error: busy }
			return withControlSession(
				{ sessionId: target.join.sessionId, cwd: target.join.cwd, createQuery: deps.createQuery, timeoutMs: deps.timeoutMs },
				async (control): Promise<ApplyRewindResult> => {
					const preview = await dryRun(control, target, deps)
					if (preview.outsideWorkspace.length > 0 || (!preview.canRewind && preview.reason)) {
						return { ok: false, error: preview.reason ?? 'These files cannot be restored.' }
					}
					if (preview.files.length === 0) return { ok: true, filesRestored: 0, skippedLinks: 0 }
					if (preview.requiresAcknowledge && input.acknowledgeUncommitted !== true) {
						return {
							ok: false,
							error: 'Some of these files have uncommitted changes. Confirm that they may be overwritten first.',
						}
					}

					const result = await control.rewindFiles(target.join.uuid)
					if (!result.canRewind) return { ok: false, error: result.error ?? 'The files could not be restored.' }
					/*
					 * `skippedLinks` counts tracked files the CLI refused to touch — a symlink or hard
					 * link at the path, or a parent directory that moved. Only a real rewind reports
					 * it (the dry run never does), so the preview's count includes them.
					 */
					const skippedLinks = Math.min(preview.files.length, Math.max(0, result.skippedLinks ?? 0))
					logger.info('[chat/rewind] files restored', {
						conversationId: target.conversationId,
						messageId: input.messageId,
						files: preview.files.length,
						skippedLinks,
					})
					return { ok: true, filesRestored: preview.files.length - skippedLinks, skippedLinks }
				},
			)
		})
	} catch (error) {
		if (error instanceof RewindBusyError) return { ok: false, error: error.message }
		logger.warn('[chat/rewind] restore failed', { messageId: input.messageId, error: describeError(error) })
		return { ok: false, error: `The files could not be restored: ${describeError(error)}` }
	}
}
