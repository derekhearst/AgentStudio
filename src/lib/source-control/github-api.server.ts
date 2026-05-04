/**
 * Wave 5 #19 phase 2 — minimal GitHub REST client.
 *
 * Pure fetch wrapper — no octokit dependency. Just enough surface for OAuth-bound flows:
 *   - listAuthenticatedUserRepos: paginated listing of repos the token can access
 *   - getRepository: single repo metadata
 *   - createPullRequest: open a PR (Phase 4 will use this)
 *
 * Adds the standard GitHub headers (`Accept`, `X-GitHub-Api-Version`, `User-Agent`) on
 * every request. Surfaces rate-limit headers in the error message when 403/429 fires so
 * the caller can show the user something actionable. All requests time out after 20s.
 */

const API_ROOT = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 20_000

export type GithubRepoSummary = {
	id: number
	nodeId: string
	name: string
	fullName: string
	owner: { login: string; type: 'User' | 'Organization' }
	private: boolean
	htmlUrl: string
	cloneUrl: string
	sshUrl: string
	defaultBranch: string
	description: string | null
	fork: boolean
	archived: boolean
	updatedAt: string | null
	pushedAt: string | null
	stargazersCount: number
}

class GithubApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message)
		this.name = 'GithubApiError'
	}
}

async function ghFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
	const ac = new AbortController()
	const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
	try {
		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'AgentStudio',
			...(init.headers ?? {}),
		}
		return await fetch(`${API_ROOT}${path}`, { ...init, headers, signal: ac.signal })
	} finally {
		clearTimeout(timer)
	}
}

function mapRepoSummary(raw: Record<string, unknown>): GithubRepoSummary {
	const owner = raw.owner as { login: string; type: 'User' | 'Organization' }
	return {
		id: raw.id as number,
		nodeId: (raw.node_id as string) ?? '',
		name: raw.name as string,
		fullName: raw.full_name as string,
		owner: { login: owner.login, type: owner.type },
		private: !!raw.private,
		htmlUrl: (raw.html_url as string) ?? '',
		cloneUrl: (raw.clone_url as string) ?? '',
		sshUrl: (raw.ssh_url as string) ?? '',
		defaultBranch: (raw.default_branch as string) ?? 'main',
		description: (raw.description as string | null) ?? null,
		fork: !!raw.fork,
		archived: !!raw.archived,
		updatedAt: (raw.updated_at as string | null) ?? null,
		pushedAt: (raw.pushed_at as string | null) ?? null,
		stargazersCount: (raw.stargazers_count as number) ?? 0,
	}
}

export async function listAuthenticatedUserRepos(
	token: string,
	options?: { perPage?: number; maxPages?: number; visibility?: 'all' | 'public' | 'private' },
): Promise<GithubRepoSummary[]> {
	const perPage = Math.min(options?.perPage ?? 50, 100)
	const maxPages = Math.min(options?.maxPages ?? 4, 10) // cap at 1000 repos to avoid runaway loops
	const visibility = options?.visibility ?? 'all'
	const out: GithubRepoSummary[] = []
	for (let page = 1; page <= maxPages; page++) {
		const params = new URLSearchParams({
			per_page: String(perPage),
			page: String(page),
			sort: 'updated',
			visibility,
			affiliation: 'owner,collaborator,organization_member',
		})
		const res = await ghFetch(token, `/user/repos?${params.toString()}`)
		if (res.status === 401) throw new GithubApiError('GitHub token rejected (401). Reconnect to refresh.', 401)
		if (res.status === 403) {
			const rateRemaining = res.headers.get('x-ratelimit-remaining')
			throw new GithubApiError(
				`GitHub forbade the request (403)${rateRemaining === '0' ? ' — rate-limit exhausted' : ''}.`,
				403,
			)
		}
		if (!res.ok) throw new GithubApiError(`GitHub list-repos failed: HTTP ${res.status}`, res.status)
		const arr = (await res.json()) as Record<string, unknown>[]
		if (!Array.isArray(arr)) break
		for (const r of arr) out.push(mapRepoSummary(r))
		if (arr.length < perPage) break // last page — no more results
	}
	return out
}

export async function getRepository(token: string, owner: string, repo: string): Promise<GithubRepoSummary> {
	const res = await ghFetch(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
	if (res.status === 404) throw new GithubApiError(`Repo ${owner}/${repo} not found or no access`, 404)
	if (!res.ok) throw new GithubApiError(`GitHub get-repo failed: HTTP ${res.status}`, res.status)
	const raw = (await res.json()) as Record<string, unknown>
	return mapRepoSummary(raw)
}

export type CreatePullRequestInput = {
	owner: string
	repo: string
	title: string
	body?: string
	head: string
	base: string
	draft?: boolean
}

export async function createPullRequest(token: string, input: CreatePullRequestInput): Promise<{
	number: number
	htmlUrl: string
	state: 'open' | 'closed'
	draft: boolean
}> {
	const res = await ghFetch(token, `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			title: input.title,
			body: input.body,
			head: input.head,
			base: input.base,
			draft: input.draft ?? false,
		}),
	})
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		throw new GithubApiError(`GitHub create-PR failed (${res.status}): ${text.slice(0, 400)}`, res.status)
	}
	const raw = (await res.json()) as Record<string, unknown>
	return {
		number: raw.number as number,
		htmlUrl: (raw.html_url as string) ?? '',
		state: (raw.state as 'open' | 'closed') ?? 'open',
		draft: !!raw.draft,
	}
}

export { GithubApiError }
