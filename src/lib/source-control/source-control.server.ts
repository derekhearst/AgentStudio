import { and, desc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import {
	pullRequestChecks,
	pullRequests,
	repositories,
	repositoryBranches,
	repositoryConnections,
	type PullRequestRow,
	type PullRequestStatus,
	type RepositoryConnectionRow,
	type RepositoryRow,
	type SourceControlProvider,
} from './source-control.schema'

/**
 * Wave 5 #19 phase 1 — server CRUD for source-control records.
 *
 * Schema-only slice — provider sync (poll/webhook against GitHub etc.) is Phase 5 work.
 * For now this module exposes the durable record management so a UI can attach repos +
 * track PRs that are created out-of-band (e.g. manually via gh CLI). Phase 3 adds the
 * agent tool surface; Phase 4 adds provider-side PR creation.
 */

// ─────────── Repositories ───────────

export type AttachRepositoryInput = {
	userId: string
	provider?: SourceControlProvider
	owner: string
	name: string
	cloneUrl: string
	defaultBranch?: string
	projectId?: string | null
	metadata?: Record<string, unknown>
}

export async function attachRepository(input: AttachRepositoryInput): Promise<RepositoryRow> {
	const [row] = await db
		.insert(repositories)
		.values({
			userId: input.userId,
			provider: input.provider ?? 'github',
			owner: input.owner,
			name: input.name,
			cloneUrl: input.cloneUrl,
			defaultBranch: input.defaultBranch ?? 'main',
			projectId: input.projectId ?? null,
			metadata: input.metadata ?? {},
		})
		.returning()
	return row
}

export async function listRepositories(userId: string): Promise<RepositoryRow[]> {
	return db
		.select()
		.from(repositories)
		.where(eq(repositories.userId, userId))
		.orderBy(desc(repositories.updatedAt))
}

export async function getRepositoryById(repositoryId: string): Promise<RepositoryRow | null> {
	const [row] = await db.select().from(repositories).where(eq(repositories.id, repositoryId)).limit(1)
	return row ?? null
}

// ─────────── Connections ───────────

export type UpsertConnectionInput = {
	userId: string
	provider: SourceControlProvider
	providerAccount: string
	encryptedToken: string
	scopes?: string[]
}

export async function upsertConnection(input: UpsertConnectionInput): Promise<RepositoryConnectionRow> {
	const [row] = await db
		.insert(repositoryConnections)
		.values({
			userId: input.userId,
			provider: input.provider,
			providerAccount: input.providerAccount,
			encryptedToken: input.encryptedToken,
			scopes: input.scopes ?? [],
			status: 'active',
			lastSyncedAt: new Date(),
			lastError: null,
		})
		.onConflictDoUpdate({
			target: [
				repositoryConnections.userId,
				repositoryConnections.provider,
				repositoryConnections.providerAccount,
			],
			set: {
				encryptedToken: input.encryptedToken,
				scopes: input.scopes ?? [],
				status: 'active',
				lastSyncedAt: new Date(),
				lastError: null,
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function markConnectionStatus(
	connectionId: string,
	status: 'active' | 'error' | 'revoked' | 'pending',
	lastError?: string | null,
): Promise<RepositoryConnectionRow | null> {
	const [row] = await db
		.update(repositoryConnections)
		.set({ status, lastError: lastError ?? null, updatedAt: new Date() })
		.where(eq(repositoryConnections.id, connectionId))
		.returning()
	return row ?? null
}

export async function listConnections(userId: string): Promise<RepositoryConnectionRow[]> {
	return db
		.select()
		.from(repositoryConnections)
		.where(eq(repositoryConnections.userId, userId))
		.orderBy(desc(repositoryConnections.updatedAt))
}

// ─────────── Pull requests ───────────

export type RecordPullRequestInput = {
	repositoryId: string
	providerPrNumber: number
	title: string
	body?: string | null
	headBranch: string
	baseBranch: string
	status?: PullRequestStatus
	taskId?: string | null
	runId?: string | null
	createdBy?: string | null
	providerUrl?: string | null
	metadata?: Record<string, unknown>
}

/**
 * Record a pull request known to the system. Idempotent on (repositoryId, providerPrNumber)
 * — re-recording an existing PR updates the mutable fields (status, body, metadata, etc.)
 * without creating a duplicate row. Use for both agent-created and externally-created PRs.
 */
export async function recordPullRequest(input: RecordPullRequestInput): Promise<PullRequestRow> {
	const [row] = await db
		.insert(pullRequests)
		.values({
			repositoryId: input.repositoryId,
			providerPrNumber: input.providerPrNumber,
			title: input.title,
			body: input.body ?? null,
			headBranch: input.headBranch,
			baseBranch: input.baseBranch,
			status: input.status ?? 'draft',
			taskId: input.taskId ?? null,
			runId: input.runId ?? null,
			createdBy: input.createdBy ?? null,
			providerUrl: input.providerUrl ?? null,
			metadata: input.metadata ?? {},
		})
		.onConflictDoUpdate({
			target: [pullRequests.repositoryId, pullRequests.providerPrNumber],
			set: {
				title: input.title,
				body: input.body ?? null,
				status: input.status ?? 'draft',
				providerUrl: input.providerUrl ?? null,
				metadata: input.metadata ?? {},
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function listPullRequestsForRepository(repositoryId: string): Promise<PullRequestRow[]> {
	return db
		.select()
		.from(pullRequests)
		.where(eq(pullRequests.repositoryId, repositoryId))
		.orderBy(desc(pullRequests.updatedAt))
}

export async function getPullRequestById(prId: string): Promise<PullRequestRow | null> {
	const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, prId)).limit(1)
	return row ?? null
}

// ─────────── PR checks ───────────

export async function recordPullRequestCheck(input: {
	pullRequestId: string
	checkName: string
	status: 'pending' | 'running' | 'success' | 'failure' | 'canceled' | 'skipped'
	detailsUrl?: string | null
	metadata?: Record<string, unknown>
	startedAt?: Date | null
	finishedAt?: Date | null
}) {
	const [row] = await db
		.insert(pullRequestChecks)
		.values({
			pullRequestId: input.pullRequestId,
			checkName: input.checkName,
			status: input.status,
			detailsUrl: input.detailsUrl ?? null,
			metadata: input.metadata ?? {},
			startedAt: input.startedAt ?? null,
			finishedAt: input.finishedAt ?? null,
		})
		.onConflictDoUpdate({
			target: [pullRequestChecks.pullRequestId, pullRequestChecks.checkName],
			set: {
				status: input.status,
				detailsUrl: input.detailsUrl ?? null,
				metadata: input.metadata ?? {},
				startedAt: input.startedAt ?? null,
				finishedAt: input.finishedAt ?? null,
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function listChecksForPullRequest(prId: string) {
	return db
		.select()
		.from(pullRequestChecks)
		.where(eq(pullRequestChecks.pullRequestId, prId))
		.orderBy(pullRequestChecks.checkName)
}

// ─────────── Branch tracking ───────────

export async function recordBranch(input: {
	repositoryId: string
	name: string
	taskId?: string | null
	createdByRunId?: string | null
	headSha?: string | null
	isDefault?: boolean
	state?: string | null
}) {
	const [row] = await db
		.insert(repositoryBranches)
		.values({
			repositoryId: input.repositoryId,
			name: input.name,
			taskId: input.taskId ?? null,
			createdByRunId: input.createdByRunId ?? null,
			headSha: input.headSha ?? null,
			isDefault: input.isDefault ?? false,
			state: input.state ?? null,
		})
		.onConflictDoUpdate({
			target: [repositoryBranches.repositoryId, repositoryBranches.name],
			set: {
				headSha: input.headSha ?? null,
				state: input.state ?? null,
				updatedAt: new Date(),
			},
		})
		.returning()
	return row
}

export async function listBranchesForRepository(repositoryId: string) {
	return db
		.select()
		.from(repositoryBranches)
		.where(eq(repositoryBranches.repositoryId, repositoryId))
		.orderBy(desc(repositoryBranches.updatedAt))
}

void and // tree-shake guard
