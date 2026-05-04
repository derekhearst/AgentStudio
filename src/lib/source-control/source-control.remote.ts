import { command, query } from '$app/server'
import { z } from 'zod'
import {
	disconnectGithubForUser,
	listConnections,
	listRepositories,
	syncGithubReposForUser,
} from './source-control.server'
import { isGithubOAuthConfigured } from './github-oauth.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

/**
 * Wave 5 #19 phase 2 — UI surface for /source-control admin page.
 *
 * Exposes only what the page needs: list connections + repos + sync + disconnect. The
 * OAuth flow itself runs through dedicated SvelteKit endpoints (server-side redirect
 * handlers) under /source-control/github/(connect|callback) — those don't fit the remote-
 * function shape because they need to issue a 302 to GitHub.
 */

export const getSourceControlOverviewQuery = query(async () => {
	const user = requireAuthenticatedRequestUser()
	const [connections, repos] = await Promise.all([listConnections(user.id), listRepositories(user.id)])
	return {
		githubConfigured: isGithubOAuthConfigured(),
		connections: connections.map((c) => ({
			id: c.id,
			provider: c.provider,
			providerAccount: c.providerAccount,
			scopes: c.scopes,
			status: c.status,
			lastSyncedAt: c.lastSyncedAt,
			lastError: c.lastError,
			updatedAt: c.updatedAt,
		})),
		repositories: repos.map((r) => ({
			id: r.id,
			provider: r.provider,
			owner: r.owner,
			name: r.name,
			defaultBranch: r.defaultBranch,
			cloneUrl: r.cloneUrl,
			metadata: r.metadata,
			updatedAt: r.updatedAt,
		})),
	}
})

const syncSchema = z
	.object({
		includeForks: z.boolean().optional(),
		includeArchived: z.boolean().optional(),
		maxPages: z.number().int().min(1).max(10).optional(),
	})
	.default({})

export const syncGithubReposCommand = command(syncSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	return syncGithubReposForUser(user.id, input)
})

export const disconnectGithubCommand = command(async () => {
	const user = requireAuthenticatedRequestUser()
	return disconnectGithubForUser(user.id)
})
