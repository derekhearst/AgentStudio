/**
 * Source control redesign — minimal Azure DevOps REST client.
 *
 * Two endpoints used by the import flow:
 *   - listAccounts: orgs the authenticated user is a member of (used to bootstrap the
 *     per-org connection rows in the OAuth callback).
 *   - listRepositoriesForOrg: repos in a given org, flattened across projects (the picker
 *     groups them client-side).
 *
 * Bearer auth, 20s timeout. Same shape as github-api.server.ts so the import flow's
 * candidate-list logic can be uniform.
 */

const REQUEST_TIMEOUT_MS = 20_000

export type AzureAccount = {
	accountId: string
	accountName: string
	accountType: string | null
}

export type AzureRepoSummary = {
	id: string
	name: string
	project: string
	defaultBranch: string
	cloneUrl: string
	htmlUrl: string
	size: number | null
}

export class AzureDevOpsApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message)
		this.name = 'AzureDevOpsApiError'
	}
}

async function azFetch(token: string, url: string): Promise<Response> {
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
	try {
		return await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/json',
				'User-Agent': 'AgentStudio',
			},
			signal: ac.signal,
		})
	} finally {
		clearTimeout(timer)
	}
}

/**
 * List the Azure DevOps orgs the authenticated user belongs to. Requires the `vso.profile`
 * scope. The endpoint returns an array — we map to a stable shape so callers don't depend
 * on Azure's snake-case field names.
 */
export async function listAzureAccounts(token: string): Promise<AzureAccount[]> {
	const res = await azFetch(
		token,
		'https://app.vssps.visualstudio.com/_apis/accounts?api-version=7.1',
	)
	if (res.status === 401) throw new AzureDevOpsApiError('Azure DevOps token rejected (401). Reconnect.', 401)
	if (res.status === 403) throw new AzureDevOpsApiError('Azure DevOps forbade the request (403).', 403)
	if (!res.ok) throw new AzureDevOpsApiError(`Azure list-accounts failed: HTTP ${res.status}`, res.status)
	const json = (await res.json()) as { value?: Array<Record<string, unknown>> }
	const accounts = Array.isArray(json.value) ? json.value : []
	return accounts.map((raw) => ({
		accountId: String(raw.accountId ?? raw.AccountId ?? ''),
		accountName: String(raw.accountName ?? raw.AccountName ?? ''),
		accountType: raw.accountType ? String(raw.accountType) : null,
	}))
}

/**
 * List all git repos visible to the user inside a single Azure DevOps org. Includes repos
 * from every project the user can see; the UI groups by project for readability.
 */
export async function listAzureRepositoriesForOrg(
	token: string,
	org: string,
): Promise<AzureRepoSummary[]> {
	const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/git/repositories?api-version=7.1`
	const res = await azFetch(token, url)
	if (res.status === 401) throw new AzureDevOpsApiError('Azure DevOps token rejected (401). Reconnect.', 401)
	if (res.status === 403) throw new AzureDevOpsApiError(`Azure DevOps forbade list-repos in org ${org} (403).`, 403)
	if (!res.ok) throw new AzureDevOpsApiError(`Azure list-repos failed: HTTP ${res.status}`, res.status)
	const json = (await res.json()) as { value?: Array<Record<string, unknown>> }
	const repos = Array.isArray(json.value) ? json.value : []
	return repos.map((raw) => {
		const project = (raw.project as { name?: string } | undefined)?.name ?? ''
		const name = String(raw.name ?? '')
		const defaultBranch =
			typeof raw.defaultBranch === 'string'
				? (raw.defaultBranch as string).replace(/^refs\/heads\//, '')
				: 'main'
		const remoteUrl =
			typeof raw.remoteUrl === 'string' ? (raw.remoteUrl as string) : null
		const webUrl = typeof raw.webUrl === 'string' ? (raw.webUrl as string) : null
		return {
			id: String(raw.id ?? ''),
			name,
			project,
			defaultBranch,
			cloneUrl:
				remoteUrl ??
				`https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`,
			htmlUrl:
				webUrl ?? `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(name)}`,
			size: typeof raw.size === 'number' ? (raw.size as number) : null,
		}
	})
}
