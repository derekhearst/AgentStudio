import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isPathWithin, isRealPathWithin } from './containment.server'
import { ensureWorktree, type GitRunner } from './worktree.server'

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/
const DEFAULT_SANDBOX_ROOT = '/workspace/users'

function sanitize(id: string, kind: string): string {
	if (!ID_PATTERN.test(id)) {
		throw new Error(`Invalid ${kind} for sandbox workspace: ${id}`)
	}
	return id
}

export type WorktreeConfig = {
	/** Absolute path of the source git repo to base the worktree on. */
	repoPath: string
	/** Branch to base the new worktree on. Defaults to the source repo's HEAD. */
	baseBranch?: string
	/** When true, also delete the run/<runId> branch on cleanup. Default: keep it. */
	deleteBranchOnCleanup?: boolean
	/**
	 * Wave 5 #19 phase 2 finish — explicit branch name override. Repo-backed task runs use
	 * `agent/<taskId>/attempt-<N>` so branches reflect the originating task and survive
	 * across run-id retries. Falls back to `run/<runId>` when omitted.
	 */
	branch?: string
}

export type WorkspaceContext = {
	userId: string
	/** Run ID — when present and no persistentKey, the workspace is run-scoped (ephemeral). */
	runId?: string | null
	/**
	 * Stable opt-in workspace key (Phase 2). When set, the workspace resolves to
	 * `${sandboxRoot}/<userId>/persistent/<key>/` and survives across runs. Use for
	 * long-running coding agents that want a stable repo checkout.
	 *
	 * Takes precedence over `runId` — if both are passed, the persistent path wins.
	 */
	persistentKey?: string | null
	/**
	 * Phase 4 of #7: when set together with `runId`, the workspace is materialized as a
	 * `git worktree add` of the source repo (a fresh `run/<runId>` branch off the base
	 * branch). Path: `${sandboxRoot}/<userId>/worktrees/<runId>`.
	 *
	 * Takes precedence over the regular run path. Mutually exclusive with `persistentKey` —
	 * if both are passed, the persistent path wins (matches the priority order in
	 * `resolveWorkspaceRoot`).
	 */
	worktree?: WorktreeConfig | null
	/**
	 * When the conversation is bound to a project, the project's sandboxed working tree
	 * (`<sandboxRoot>/<userId>/projects/<projectId>`) becomes the default cwd for tool
	 * runs. Lower priority than `persistentKey` and `worktree` (those are explicit overrides
	 * for run-isolation), but higher than the bare `runId` ephemeral path so chats bound
	 * to a project consistently land inside the project repo.
	 */
	projectId?: string | null
	/**
	 * Absolute or relative path to the sandbox root directory. Pass the value of
	 * `$env/dynamic/private`'s `SANDBOX_WORKSPACE` here (the workspace module is
	 * SvelteKit-agnostic so unit tests can inject any root they want).
	 */
	sandboxRoot?: string
}

/**
 * Which of the five workspace shapes a context resolves to. This is the one place the
 * priority order lives; `resolveWorkspaceRoot` builds its path from the answer.
 *
 * - `persistent` — the agent's opt-in stable directory; every turn starts in the same one
 * - `worktree`   — a fresh git worktree per run
 * - `project`    — the bound project's checkout; every turn starts in the same one
 * - `run`        — a fresh, empty directory per run
 * - `user`       — the bare per-user root (no run, no project: admin and legacy callers)
 */
export type WorkspaceKind = 'persistent' | 'worktree' | 'project' | 'run' | 'user'

export function workspaceKind(
	ctx: Pick<WorkspaceContext, 'persistentKey' | 'worktree' | 'runId' | 'projectId'>,
): WorkspaceKind {
	if (ctx.persistentKey) return 'persistent'
	if (ctx.worktree && ctx.runId) return 'worktree'
	if (ctx.projectId) return 'project'
	if (ctx.runId) return 'run'
	return 'user'
}

/**
 * Whether the next turn starts in the same directory as the last one. Only then does a
 * path someone picked from that directory still mean something when the turn runs.
 */
export function workspaceCarriesOver(kind: WorkspaceKind): boolean {
	return kind === 'persistent' || kind === 'project'
}

/**
 * Resolve the absolute root directory for a tool execution context.
 *
 * Resolution priority (most-specific wins, see `workspaceKind`):
 * - With `persistentKey`:        ${sandboxRoot}/<userId>/persistent/<key>   (Phase 2 — opt-in stable)
 * - Else with `worktree` + runId: ${sandboxRoot}/<userId>/worktrees/<runId> (Phase 4 — git worktree)
 * - Else with `projectId`:        ${sandboxRoot}/<userId>/projects/<projectId> (project-bound chat)
 * - Else with `runId`:            ${sandboxRoot}/<userId>/runs/<runId>      (Phase 1 — per-run isolation)
 * - Else:                          ${sandboxRoot}/<userId>                   (legacy path; back-compat for
 *   callers that haven't been migrated yet, e.g. ad-hoc/admin tool invocations outside a run loop)
 *
 * All five roots share a parent tree per user, so legacy persistent files at the user root
 * remain accessible to admin tooling but are invisible to ephemeral runs.
 */
export function resolveWorkspaceRoot(ctx: WorkspaceContext): string {
	const userId = sanitize(ctx.userId, 'userId')
	const root = ctx.sandboxRoot || DEFAULT_SANDBOX_ROOT
	switch (workspaceKind(ctx)) {
		case 'persistent':
			return resolve(root, userId, 'persistent', sanitize(ctx.persistentKey!, 'persistentKey'))
		case 'worktree':
			return resolve(root, userId, 'worktrees', sanitize(ctx.runId!, 'runId'))
		case 'project':
			return resolve(root, userId, 'projects', sanitize(ctx.projectId!, 'projectId'))
		case 'run':
			return resolve(root, userId, 'runs', sanitize(ctx.runId!, 'runId'))
		case 'user':
			return resolve(root, userId)
	}
}

/** A run's workspace, resolved once so every consumer agrees on it. */
export type RunWorkspace = {
	/** The context, with the sandbox root this process is configured for filled in. */
	context: WorkspaceContext
	/** Absolute root: the SDK's `cwd`, the containment guard's root, where attachments land. */
	root: string
	/**
	 * True when the root IS the bound project's checkout, rather than a persistent or
	 * worktree directory the agent's config chose instead. A project's trust flag is a
	 * statement about that checkout's committed `.claude/`, so it only applies when the run
	 * is actually standing in it.
	 */
	projectCheckout: boolean
}

/**
 * Resolve the workspace for one run against the configured sandbox root.
 *
 * The chat route used to call `resolveWorkspaceRoot` inline without a `sandboxRoot`, so
 * the containment guard fell back to `DEFAULT_SANDBOX_ROOT` while the tools, attachment
 * staging and project checkouts all used `SANDBOX_WORKSPACE` — in production they were
 * different directories, and every built-in file call into the real workspace was refused.
 * Everything that needs a run's root takes it from one call to this.
 *
 * `sandboxRoot` defaults to `process.env.SANDBOX_WORKSPACE` here, deliberately not inside
 * `resolveWorkspaceRoot`, whose callers (and specs) pass their root explicitly.
 */
export function resolveRunWorkspace(
	ctx: WorkspaceContext,
	sandboxRoot: string | undefined = ctx.sandboxRoot ?? process.env.SANDBOX_WORKSPACE,
): RunWorkspace {
	const context: WorkspaceContext = { ...ctx, sandboxRoot }
	const root = resolveWorkspaceRoot(context)
	const projectCheckout = Boolean(
		ctx.projectId && root === resolveWorkspaceRoot({ userId: ctx.userId, projectId: ctx.projectId, sandboxRoot }),
	)
	return { context, root, projectCheckout }
}

/**
 * `resolveRunWorkspace`, then make sure the directory exists — the SDK refuses to spawn in a
 * working directory that is not there, and a worktree run's checkout is created here.
 */
export async function prepareRunWorkspace(ctx: WorkspaceContext, gitRunner?: GitRunner): Promise<RunWorkspace> {
	const workspace = resolveRunWorkspace(ctx)
	await ensureWorkspace(workspace.context, gitRunner)
	return workspace
}

/**
 * Resolve `userPath` inside `workspaceRoot`, or throw if it escapes.
 *
 * Two checks, and both must pass. The lexical one catches `../` and absolute paths
 * elsewhere. The real-path one catches a symlink that sits inside the workspace but
 * points out of it — the agent's Bash can create one, and an imported repo can commit
 * one — which the lexical check cannot see because the OS only follows the link when
 * the path is opened. Paths that do not exist yet are judged by their nearest existing
 * ancestor, which is where a create would land (see `containment.server.ts`).
 *
 * Returns the lexical path, not the resolved one, so display paths and the paths handed
 * back to the model stay the ones the caller asked about.
 */
export function safePathWithin(workspaceRoot: string, userPath: string): string {
	const root = resolve(workspaceRoot)
	const resolved = resolve(root, userPath)
	if (!isPathWithin(root, resolved) || !isRealPathWithin(root, resolved)) {
		throw new Error(`Path escapes sandbox workspace: ${userPath}`)
	}
	return resolved
}

export async function ensureWorkspace(
	ctx: WorkspaceContext,
	gitRunner?: GitRunner,
): Promise<string> {
	const root = resolveWorkspaceRoot(ctx)
	if (ctx.worktree && ctx.runId && !ctx.persistentKey) {
		// git worktree add will create the leaf dir; ensureWorktree handles its parent.
		await ensureWorktree(
			{
				repoPath: ctx.worktree.repoPath,
				worktreePath: root,
				runId: ctx.runId,
				baseBranch: ctx.worktree.baseBranch,
				branch: ctx.worktree.branch,
			},
			gitRunner,
		)
		return root
	}
	// Project-backed workspaces are pre-materialized by `createProject` (`git init` for local,
	// `git clone` for imported). We only ensure the path exists here so a tool invocation
	// against a project that's somehow lost its dir doesn't blow up — but we don't try to
	// re-init the repo. The caller is expected to have created the project via the proper
	// flow.
	await mkdir(root, { recursive: true })
	return root
}
