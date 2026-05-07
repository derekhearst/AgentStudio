/**
 * Source control redesign — pure clone-URL parser.
 *
 * Parses any clone URL into a discriminated union the import flow uses to decide:
 *   - which `provider` to set on the row
 *   - which auth method to use for the clone (GitHub OAuth, Azure DevOps OAuth, anonymous)
 *   - which `credentialUsername` to pass to the credential helper
 *
 * Pure — no I/O — so the picker can preview the parsed shape client-side and the server
 * can use the same logic without duplicating the regex.
 */

export type ParsedGithub = {
	provider: 'github'
	owner: string
	repo: string
	cloneUrl: string
	htmlUrl: string
}

export type ParsedAzureDevOps = {
	provider: 'azure_devops'
	org: string
	project: string
	repo: string
	cloneUrl: string
	htmlUrl: string
}

export type ParsedLocal = {
	provider: 'local'
	host: string
	owner: string
	name: string
	cloneUrl: string
	htmlUrl: string
}

export type ParsedCloneUrl = ParsedGithub | ParsedAzureDevOps | ParsedLocal

const GITHUB_HTTPS = /^https?:\/\/(?:[^/@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
const GITHUB_SSH = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i
const AZURE_DEVOPS_NEW =
	/^https?:\/\/(?:[^/@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i
const AZURE_DEVOPS_LEGACY =
	/^https?:\/\/(?:[^/@]+@)?([^/.@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+?)(?:\.git)?\/?$/i
const GENERIC_HTTPS = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i

function clean(input: string): string {
	return input.trim()
}

export function parseCloneUrl(rawInput: string): ParsedCloneUrl {
	const input = clean(rawInput)
	if (!input) throw new Error('Empty clone URL')

	const ghHttps = GITHUB_HTTPS.exec(input)
	if (ghHttps) {
		const [, owner, repo] = ghHttps
		return {
			provider: 'github',
			owner,
			repo,
			cloneUrl: `https://github.com/${owner}/${repo}.git`,
			htmlUrl: `https://github.com/${owner}/${repo}`,
		}
	}

	const ghSsh = GITHUB_SSH.exec(input)
	if (ghSsh) {
		const [, owner, repo] = ghSsh
		return {
			provider: 'github',
			owner,
			repo,
			cloneUrl: `https://github.com/${owner}/${repo}.git`,
			htmlUrl: `https://github.com/${owner}/${repo}`,
		}
	}

	const azNew = AZURE_DEVOPS_NEW.exec(input)
	if (azNew) {
		const [, org, project, repo] = azNew
		return {
			provider: 'azure_devops',
			org,
			project,
			repo,
			cloneUrl: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
			htmlUrl: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
		}
	}

	const azLegacy = AZURE_DEVOPS_LEGACY.exec(input)
	if (azLegacy) {
		const [, org, project, repo] = azLegacy
		return {
			provider: 'azure_devops',
			org,
			project,
			repo,
			cloneUrl: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
			htmlUrl: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
		}
	}

	const generic = GENERIC_HTTPS.exec(input)
	if (generic) {
		const [, host, path] = generic
		const segments = path.split('/').filter((s) => s.length > 0)
		const name = segments[segments.length - 1] ?? 'repo'
		const owner = segments.length > 1 ? segments.slice(0, -1).join('-') : host
		return {
			provider: 'local',
			host,
			owner,
			name,
			cloneUrl: input,
			htmlUrl: input,
		}
	}

	throw new Error(
		`Unsupported clone URL: ${input}. Provide an https://... URL for GitHub or Azure DevOps, or a generic public clone URL.`,
	)
}

/**
 * Pick the credential-helper username for a parsed URL. GitHub OAuth wants `x-access-token`,
 * Azure DevOps OAuth wants `oauth2`, public clones can pass an empty username (the helper
 * just hands back blank credentials and git falls back to anonymous HTTPS).
 *
 * Accepts the broader `SourceControlProvider` enum (which includes gitlab/bitbucket/gitea)
 * so callers don't have to narrow the row's provider field. Unknown providers default to
 * an empty username (anonymous clone) — the import flow only allows github/azure/local
 * upstream of this so the fallback is unreachable in practice.
 */
export function credentialUsernameForProvider(provider: string): string {
	if (provider === 'github') return 'x-access-token'
	if (provider === 'azure_devops') return 'oauth2'
	return ''
}

/**
 * Compute a stable, filesystem-safe (owner, name) pair for the local mirror layout
 * `${mirrorRoot}/<owner>/<repo>`. For Azure DevOps repos the project segment is dropped —
 * the mirror tree stays two levels deep regardless of provider. For local URLs with no
 * owner segment, falls back to the host so the row's unique key (userId, owner, name)
 * still holds.
 */
export function mirrorOwnerName(parsed: ParsedCloneUrl): { owner: string; name: string } {
	if (parsed.provider === 'github') return { owner: parsed.owner, name: parsed.repo }
	if (parsed.provider === 'azure_devops') return { owner: parsed.org, name: parsed.repo }
	return { owner: parsed.owner, name: parsed.name }
}
