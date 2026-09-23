import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { logger } from '$lib/observability/logger'
import { safePathWithin } from '$lib/workspace/workspace.server'
import { runGit } from '$lib/source-control/git-exec.server'
import { cloneRepository, materializeRepoMirror, refreshClone } from '$lib/source-control/repo-mirror.server'
import type { CloneRefreshOutcome } from '$lib/source-control/repo-mirror'

/**
 * Sandboxed filesystem layout for projects.
 *
 * Every project that is `repoKind != 'none'` gets a stable working directory at
 * `<SANDBOX_WORKSPACE>/<userId>/projects/<projectId>/`. The dir IS the working tree
 * (no bare-clone indirection); the `.git` is at the top level. Local-only projects
 * are `git init`'d here; imported projects are cloned here.
 *
 * Path safety: every helper validates the resolved path with `safePathWithin` so
 * a malformed userId/projectId can't escape `<SANDBOX_WORKSPACE>/<userId>/projects`.
 *
 * No DB writes — the caller (typically `projects.server.ts`'s `createProject`)
 * orchestrates the row + filesystem together.
 */

const DEFAULT_SANDBOX_ROOT = '/workspace/users'
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
// UUID v4 with mixed case allowed; shape-only check, not a strict v4 regex.
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9-]+$/
// No leading `-`: git would read the name as an option rather than a branch.
const SAFE_BRANCH = /^(?!-)[a-zA-Z0-9_/-]+$/

function getSandboxRoot(): string {
	return process.env.SANDBOX_WORKSPACE || DEFAULT_SANDBOX_ROOT
}

function sanitizeUserId(userId: string): string {
	if (!ID_PATTERN.test(userId)) throw new Error(`Invalid userId for project fs: ${userId}`)
	return userId
}

function sanitizeProjectId(projectId: string): string {
	if (!PROJECT_ID_PATTERN.test(projectId)) throw new Error(`Invalid projectId for project fs: ${projectId}`)
	return projectId
}

function sanitizeBranch(branch: string): string {
	if (!SAFE_BRANCH.test(branch)) throw new Error(`Invalid branch name: ${branch}`)
	return branch
}

export function getProjectsRoot(userId: string): string {
	return resolve(getSandboxRoot(), sanitizeUserId(userId), 'projects')
}

export function getProjectPath(userId: string, projectId: string): string {
	const root = getProjectsRoot(userId)
	const full = resolve(root, sanitizeProjectId(projectId))
	// Final guard: the resolved path must stay within the projects root for this user.
	return safePathWithin(root, full)
}

async function pathExists(absPath: string): Promise<boolean> {
	try {
		await stat(absPath)
		return true
	} catch {
		return false
	}
}

export type InitLocalProjectInput = {
	userId: string
	projectId: string
	defaultBranch?: string
	projectName?: string
}

export type ProjectInitResult = {
	path: string
	branch: string
}

/**
 * Initialize a brand-new local-only project repo. Creates the project directory, runs
 * `git init -b <defaultBranch>`, writes a minimal README so the working tree isn't empty,
 * and creates the initial commit so the branch ref exists. Idempotent on the directory
 * itself (mkdir -p) but throws if a `.git` already exists at the path.
 */
export async function initLocalProjectRepo(input: InitLocalProjectInput): Promise<ProjectInitResult> {
	const branch = sanitizeBranch(input.defaultBranch?.trim() || 'main')
	const projectPath = getProjectPath(input.userId, input.projectId)
	if (await pathExists(join(projectPath, '.git'))) {
		throw new Error(`Project filesystem already initialized at ${projectPath}`)
	}

	await mkdir(projectPath, { recursive: true })

	const initRes = await runGit(['init', '-b', branch], { cwd: projectPath })
	if (initRes.code !== 0) {
		throw new Error(`git init failed (exit ${initRes.code}): ${initRes.stderr.trim() || initRes.stdout.trim()}`)
	}

	const readmeBody = input.projectName?.trim()
		? `# ${input.projectName.trim()}\n`
		: '# New project\n'
	await writeFile(join(projectPath, 'README.md'), readmeBody, 'utf-8')

	// Commit identity is local-only (per-repo config) so the initial commit doesn't depend on
	// the operator having a global git identity set.
	await runGit(['config', 'user.email', 'agentstudio@local'], { repoPath: projectPath })
	await runGit(['config', 'user.name', 'AgentStudio'], { repoPath: projectPath })

	const addRes = await runGit(['add', '-A'], { repoPath: projectPath })
	if (addRes.code !== 0) {
		throw new Error(`git add failed (exit ${addRes.code}): ${addRes.stderr.trim()}`)
	}
	const commitRes = await runGit(['commit', '-m', 'Initial commit'], { repoPath: projectPath })
	if (commitRes.code !== 0) {
		throw new Error(`git commit failed (exit ${commitRes.code}): ${commitRes.stderr.trim() || commitRes.stdout.trim()}`)
	}

	return { path: projectPath, branch }
}

export type CloneIntoProjectInput = {
	userId: string
	projectId: string
	cloneUrl: string
	token?: string
	credentialUsername?: string
}

/**
 * Clone a remote into a project's sandbox path. Wraps `materializeRepoMirror` but with the
 * mirror layout pinned to `<projectsRoot>/<projectId>` (a single project clone, not the
 * legacy `<owner>/<repo>` layout). Throws if a `.git` already exists at the path.
 */
export async function cloneIntoProject(input: CloneIntoProjectInput): Promise<ProjectInitResult> {
	const projectPath = getProjectPath(input.userId, input.projectId)
	if (await pathExists(join(projectPath, '.git'))) {
		throw new Error(`Project filesystem already initialized at ${projectPath}`)
	}

	// `materializeRepoMirror` builds its target as `<mirrorRoot>/<owner>/<repo>`. For our
	// single-project layout we want `<projectsRoot>/<projectId>`, so we pass the projects
	// root as `mirrorRoot` and the projectId in the `repo` slot, with a dummy `owner='.'`
	// that will be mkdir'd as a parent. That gives `<projectsRoot>/./<projectId>` =
	// `<projectsRoot>/<projectId>`. The owner segment is allowed by sanitizeRepoSegment
	// because '.' is a single-char dot and the regex requires the FIRST char to be
	// alphanumeric/underscore/hyphen — so we use a different approach: a dedicated parent.
	//
	// Actually, simpler — invoke materializeRepoMirror with `mirrorRoot=getProjectsRoot()`,
	// `owner='_p'`, `repo=projectId`. The `_p` segment is a sentinel under which all project
	// clones live: `<projectsRoot>/_p/<projectId>`. That keeps the materialize helper's
	// path layout unchanged but slightly nests our clones. We don't want that nesting —
	// agents and the rest of the app expect the project path at `<projectsRoot>/<projectId>`.
	//
	// So instead: bypass materializeRepoMirror's path builder and inline a clone here.
	const mirrorParent = getProjectsRoot(input.userId)
	await mkdir(mirrorParent, { recursive: true })

	await cloneRepository({
		remoteUrl: input.cloneUrl,
		targetPath: projectPath,
		token: input.token ?? '',
		credentialUsername: input.credentialUsername,
		cwd: mirrorParent,
	})

	let branch = 'main'
	const headRes = await runGit(['symbolic-ref', '--short', 'HEAD'], { repoPath: projectPath })
	if (headRes.code === 0) {
		const detected = headRes.stdout.trim()
		if (detected.length > 0) branch = detected
	}

	return { path: projectPath, branch }
}

/**
 * Refresh the project's clone from its remote — the "Pull latest" button. Every remote
 * branch is fetched into `origin/*`, and the checked-out branch is fast-forwarded when it
 * is strictly behind; `refreshClone` says when it is left alone instead. The token travels
 * as a URL-scoped header in the child environment, never argv.
 */
export async function fetchProjectRemote(input: {
	userId: string
	projectId: string
	cloneUrl: string
	token?: string
	credentialUsername?: string
}): Promise<CloneRefreshOutcome> {
	const projectPath = getProjectPath(input.userId, input.projectId)
	if (!(await pathExists(join(projectPath, '.git')))) {
		throw new Error(`Project is not a git repository: ${projectPath}`)
	}
	return refreshClone({
		repoPath: projectPath,
		remoteUrl: input.cloneUrl,
		token: input.token ?? '',
		credentialUsername: input.credentialUsername,
	})
}

/**
 * Hard-delete the project's filesystem. Best-effort — silently swallows ENOENT so calling
 * `deleteProjectFs` after a failed clone (where the dir may or may not exist) is safe.
 */
export async function deleteProjectFs(userId: string, projectId: string): Promise<void> {
	const projectPath = getProjectPath(userId, projectId)
	try {
		await rm(projectPath, { recursive: true, force: true })
	} catch (err) {
		logger.warn('[projects] deleteProjectFs failed', { userId, projectId, err })
	}
}

// Re-exported so `projects.server.ts` can pass a stub mirror result through after a clone
// (the current callers don't use this directly, but the export keeps the surface symmetric
// with source-control's `materializeRepoMirror` for any future refactor).
export { materializeRepoMirror }
