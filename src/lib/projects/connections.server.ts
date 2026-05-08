/**
 * Re-export the OAuth connection + import-candidate helpers under a `projects/`-prefixed
 * path so the projects UI doesn't reach into `source-control` for them. The underlying
 * implementations stay in `source-control.server.ts` for now (they're pure API wrappers
 * + DB upserts that touch `repository_connections`) — moving the bodies isn't worth the
 * git-blame churn.
 *
 * If/when the source-control module is fully demolished, the bodies can be lifted here.
 */

export {
	disconnectAzureForUser,
	disconnectGithubForUser,
	getActiveAzureConnection,
	getActiveGithubConnection,
	listActiveAzureConnections,
	listAzureImportCandidates,
	listConnections,
	listGithubImportCandidates,
	syncGithubReposForUser,
	upsertConnection,
	type AzureImportCandidate,
	type GithubImportCandidate,
} from '$lib/source-control/source-control.server'

export { isGithubOAuthConfigured } from '$lib/source-control/github-oauth.server'
export { isAzureDevOpsOAuthConfigured } from '$lib/source-control/azure-devops-oauth.server'
