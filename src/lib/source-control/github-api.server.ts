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

// ─────────── #20: CI watch ───────────

export type GithubPullRequestState = {
	number: number
	state: 'open' | 'closed'
	merged: boolean
	draft: boolean
	title: string
	body: string | null
	headBranch: string
	baseBranch: string
	headSha: string | null
	htmlUrl: string
	mergedAt: string | null
	closedAt: string | null
	updatedAt: string | null
}

/**
 * Read one PR's current state from the provider. This is how the poller learns that a PR
 * merged or closed while nobody was looking — without it, a watch would keep polling a
 * dead PR until its window expired.
 */
export async function getPullRequestFromProvider(
	token: string,
	owner: string,
	repo: string,
	prNumber: number,
): Promise<GithubPullRequestState> {
	const res = await ghFetch(
		token,
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`,
	)
	if (res.status === 404) throw new GithubApiError(`PR ${owner}/${repo}#${prNumber} not found or no access`, 404)
	if (!res.ok) throw new GithubApiError(`GitHub get-PR failed: HTTP ${res.status}`, res.status)
	const raw = (await res.json()) as Record<string, unknown>
	const head = (raw.head as Record<string, unknown> | undefined) ?? {}
	const base = (raw.base as Record<string, unknown> | undefined) ?? {}
	return {
		number: raw.number as number,
		state: ((raw.state as string) === 'closed' ? 'closed' : 'open') as 'open' | 'closed',
		merged: raw.merged === true,
		draft: raw.draft === true,
		title: (raw.title as string) ?? '',
		body: typeof raw.body === 'string' ? raw.body : null,
		headBranch: (head.ref as string) ?? '',
		baseBranch: (base.ref as string) ?? '',
		headSha: typeof head.sha === 'string' ? head.sha : null,
		htmlUrl: (raw.html_url as string) ?? '',
		mergedAt: typeof raw.merged_at === 'string' ? raw.merged_at : null,
		closedAt: typeof raw.closed_at === 'string' ? raw.closed_at : null,
		updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
	}
}

/**
 * Raw entries from `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` — the modern
 * Checks API, which is what GitHub Actions reports through. Shaping is left to
 * `normalizeCheckRun` in `pr-checks.ts` so the poller and the webhook share one mapping.
 *
 * One page (100 runs) is deliberate: a commit with more than a hundred checks is not a
 * situation a notification is going to improve.
 */
export async function listCheckRunsForRef(
	token: string,
	owner: string,
	repo: string,
	ref: string,
): Promise<Record<string, unknown>[]> {
	const res = await ghFetch(
		token,
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
	)
	if (res.status === 404) return []
	if (!res.ok) throw new GithubApiError(`GitHub list-check-runs failed: HTTP ${res.status}`, res.status)
	const raw = (await res.json()) as { check_runs?: unknown }
	return Array.isArray(raw.check_runs) ? (raw.check_runs as Record<string, unknown>[]) : []
}

/**
 * Raw entries from the legacy combined-status API. Still the only surface for third-party
 * CI that never migrated to Checks (older Jenkins/CircleCI integrations), so a PR whose CI
 * lives there would otherwise look permanently unchecked.
 */
export async function listCommitStatusesForRef(
	token: string,
	owner: string,
	repo: string,
	ref: string,
): Promise<Record<string, unknown>[]> {
	const res = await ghFetch(
		token,
		`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status?per_page=100`,
	)
	if (res.status === 404) return []
	if (!res.ok) throw new GithubApiError(`GitHub combined-status failed: HTTP ${res.status}`, res.status)
	const raw = (await res.json()) as { statuses?: unknown }
	return Array.isArray(raw.statuses) ? (raw.statuses as Record<string, unknown>[]) : []
}

/**
 * Plain-text log for one GitHub Actions job. For Actions-produced checks the `check_run`
 * id IS the job id, which is the only reason a log excerpt is reachable at all from a
 * check.
 *
 * Best-effort by contract: returns null rather than throwing. The endpoint 302s to a
 * short-lived blob URL, 404s once GitHub has expired the log, and does not exist at all
 * for checks that did not come from Actions. None of those are a reason to fail a poll —
 * the review item is still worth opening with the check's own summary.
 *
 * Memory is bounded two ways, and they are not the same bound. `tailBytes` is what we
 * KEEP — a rolling window over the stream, because the end of a build log is the part that
 * says why it died and the beginning is dependency installation. `maxReadBytes` is what we
 * are willing to READ before giving up on reaching the end; a pathological 200MB log is
 * not worth the bandwidth, and its head is useless, so that case returns null rather than
 * an excerpt that silently points at the wrong part of the run.
 */
export async function fetchActionsJobLog(
	token: string,
	owner: string,
	repo: string,
	jobId: number,
	options: { tailBytes?: number; maxReadBytes?: number } = {},
): Promise<string | null> {
	const tailBytes = options.tailBytes ?? 256 * 1024
	const maxReadBytes = options.maxReadBytes ?? 16 * 1024 * 1024
	try {
		const res = await ghFetch(
			token,
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`,
		)
		if (!res.ok || !res.body) return null
		const reader = res.body.getReader()
		// Rolling window: hold at most ~2x tailBytes, dropping from the front.
		let window: Uint8Array[] = []
		let windowBytes = 0
		let readBytes = 0
		let overran = false
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value) continue
			readBytes += value.byteLength
			if (readBytes > maxReadBytes) {
				overran = true
				await reader.cancel().catch(() => undefined)
				break
			}
			window.push(value)
			windowBytes += value.byteLength
			while (windowBytes - (window[0]?.byteLength ?? 0) >= tailBytes && window.length > 1) {
				windowBytes -= window[0].byteLength
				window = window.slice(1)
			}
		}
		if (overran || window.length === 0) return null
		const merged = new Uint8Array(windowBytes)
		let offset = 0
		for (const chunk of window) {
			merged.set(chunk, offset)
			offset += chunk.byteLength
		}
		return new TextDecoder().decode(merged)
	} catch {
		// Aborted fetch, expired blob URL, non-Actions check — all "no excerpt available".
		return null
	}
}

export { GithubApiError }
