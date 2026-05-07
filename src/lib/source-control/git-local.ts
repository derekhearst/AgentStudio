/**
 * Wave 5 #19 phase 3 — local git introspection helpers.
 *
 * Pure argv builders + output parsers for `git status` and `git diff --stat`. No I/O so
 * unit tests can pin the parser contracts against fixed sample output (`git`'s text
 * format is documented + stable enough for our needs). The companion
 * `git-local.server.ts` wraps these with a `GitRunner` (the same shell runner the
 * worktree primitives use) so a single fake runner covers both code paths in tests.
 *
 * Why local-only at this stage: phase 2 (real-clone provisioning) hasn't shipped, so
 * the agent's working directory is whatever the operator already has under
 * `SANDBOX_WORKSPACE`. The agent can't navigate outside the workspace root even with
 * these tools — the server wrapper resolves the supplied path through `safePathWithin`.
 */

export function buildStatusArgs(repoPath: string): string[] {
	return ['-C', repoPath, 'status', '--porcelain=v1', '--branch']
}

export function buildDiffStatArgs(repoPath: string): string[] {
	// `--no-color` keeps the output stable for parsing across user terminal configs.
	return ['-C', repoPath, 'diff', '--stat', '--no-color', 'HEAD']
}

export type GitFileStatus = {
	path: string
	indexStatus: string
	worktreeStatus: string
	renamedFrom?: string
}

export type GitStatusSummary = {
	branch: string | null
	upstream: string | null
	ahead: number
	behind: number
	files: GitFileStatus[]
	dirty: boolean
}

const BRANCH_LINE = /^##\s+([^.\s]+)(?:\.\.\.([^\s]+)(?:\s+\[(.*)\])?)?/

/**
 * Parse `git status --porcelain=v1 --branch` output. Returns a typed summary so the
 * agent gets stable, machine-readable shape instead of raw text.
 *
 * Branch line format: `## <branch>...<upstream> [ahead N, behind M]`
 * File line format:    `XY <path>` where XY is the two-character status code; `XY <new> -> <old>`
 *                       indicates a rename.
 */
export function parseGitStatusOutput(stdout: string): GitStatusSummary {
	const summary: GitStatusSummary = {
		branch: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		files: [],
		dirty: false,
	}
	const lines = stdout.split(/\r?\n/)
	for (const raw of lines) {
		if (raw.length === 0) continue

		if (raw.startsWith('## ')) {
			const m = BRANCH_LINE.exec(raw)
			if (m) {
				summary.branch = m[1] ?? null
				summary.upstream = m[2] ?? null
				const tracking = m[3] ?? ''
				const aheadMatch = /ahead (\d+)/.exec(tracking)
				const behindMatch = /behind (\d+)/.exec(tracking)
				if (aheadMatch) summary.ahead = parseInt(aheadMatch[1], 10)
				if (behindMatch) summary.behind = parseInt(behindMatch[1], 10)
			}
			// Detached-HEAD line: `## HEAD (no branch)`
			if (raw.includes('(no branch)')) {
				summary.branch = null
			}
			continue
		}

		if (raw.length < 3) continue
		const indexStatus = raw[0]
		const worktreeStatus = raw[1]
		const rest = raw.slice(3)

		const renameIdx = rest.indexOf(' -> ')
		if (renameIdx >= 0) {
			summary.files.push({
				path: rest.slice(renameIdx + 4),
				renamedFrom: rest.slice(0, renameIdx),
				indexStatus,
				worktreeStatus,
			})
		} else {
			summary.files.push({ path: rest, indexStatus, worktreeStatus })
		}
	}
	summary.dirty = summary.files.length > 0
	return summary
}

export type GitDiffFile = {
	path: string
	insertions: number
	deletions: number
}

export type GitDiffStatSummary = {
	filesChanged: number
	insertions: number
	deletions: number
	files: GitDiffFile[]
}

const DIFFSTAT_FILE = /^\s*(.+?)\s+\|\s+(\d+)\s+([+]*)([-]*)\s*$/
const DIFFSTAT_BIN = /^\s*(.+?)\s+\|\s+Bin\b/
const DIFFSTAT_TOTAL = /^\s*(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/

/**
 * Parse `git diff --stat HEAD` output. Output shape:
 *
 *   path/to/file.ts | 12 +++++-----
 *   another/file.md |  3 +++
 *   binary/asset.png | Bin 0 -> 5489 bytes
 *    3 files changed, 12 insertions(+), 5 deletions(-)
 *
 * Per-file insertions/deletions are inferred from the +/- count after the `|` pipe.
 * The summary line is authoritative when present; if it's missing (no changes), all
 * counts are zero.
 */
export function parseGitDiffStatOutput(stdout: string): GitDiffStatSummary {
	const summary: GitDiffStatSummary = { filesChanged: 0, insertions: 0, deletions: 0, files: [] }
	const lines = stdout.split(/\r?\n/)
	let totalSeen = false
	for (const raw of lines) {
		if (raw.length === 0) continue

		const totalMatch = DIFFSTAT_TOTAL.exec(raw)
		if (totalMatch) {
			summary.filesChanged = parseInt(totalMatch[1], 10)
			summary.insertions = totalMatch[2] ? parseInt(totalMatch[2], 10) : 0
			summary.deletions = totalMatch[3] ? parseInt(totalMatch[3], 10) : 0
			totalSeen = true
			continue
		}

		const fileMatch = DIFFSTAT_FILE.exec(raw)
		if (fileMatch) {
			summary.files.push({
				path: fileMatch[1].trim(),
				insertions: fileMatch[3]?.length ?? 0,
				deletions: fileMatch[4]?.length ?? 0,
			})
			continue
		}

		const binMatch = DIFFSTAT_BIN.exec(raw)
		if (binMatch) {
			summary.files.push({ path: binMatch[1].trim(), insertions: 0, deletions: 0 })
		}
	}
	if (!totalSeen) {
		summary.filesChanged = summary.files.length
	}
	return summary
}

// `git log` argv + parser. Tab-separated fields keep parsing unambiguous: subjects can
// contain just about any char except a literal tab.
export function buildLogArgs(repoPath: string, opts: { limit: number }): string[] {
	const limit = Math.max(1, Math.min(opts.limit, 500))
	return [
		'-C',
		repoPath,
		'log',
		`--max-count=${limit}`,
		'--pretty=format:%H%x09%an%x09%ae%x09%cI%x09%s',
	]
}

export type GitCommitSummary = {
	sha: string
	authorName: string
	authorEmail: string
	isoDate: string
	subject: string
}

export function parseGitLogOutput(stdout: string): GitCommitSummary[] {
	if (!stdout) return []
	const out: GitCommitSummary[] = []
	const lines = stdout.split(/\r?\n/)
	for (const raw of lines) {
		if (raw.length === 0) continue
		const parts = raw.split('\t')
		if (parts.length < 5) continue
		const [sha, authorName, authorEmail, isoDate, ...rest] = parts
		out.push({
			sha,
			authorName,
			authorEmail,
			isoDate,
			subject: rest.join('\t'),
		})
	}
	return out
}

/**
 * Build a one-line conventional-commit-style suggestion from a diff-stat summary. Used by
 * `prepare_commit` so the agent gets a deterministic starting point that names the dominant
 * change kind (feat / fix / docs / refactor / chore) based on the touched file paths. The
 * agent can override the suggestion in its `create_pull_request` payload.
 */
export function suggestCommitSubject(diff: GitDiffStatSummary): string {
	if (diff.files.length === 0) return 'chore: (no working-tree changes)'
	const onlyDocs = diff.files.every((f) => /\.(md|mdx)$/.test(f.path) || f.path.startsWith('docs/'))
	if (onlyDocs) return 'docs: update documentation'
	const onlyTests = diff.files.every((f) => /\.spec\.(ts|js|tsx|jsx)$/.test(f.path) || f.path.startsWith('tests/'))
	if (onlyTests) return 'test: update tests'
	const fileWord = diff.filesChanged === 1 ? 'file' : 'files'
	const head = diff.files[0]?.path ?? 'changes'
	const dir = head.split('/').slice(0, 2).join('/') || head
	return `feat: update ${dir} (${diff.filesChanged} ${fileWord})`
}
