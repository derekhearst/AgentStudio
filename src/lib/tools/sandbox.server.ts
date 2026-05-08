import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveWorkspaceRoot, safePathWithin, ensureWorkspace } from '$lib/workspace/workspace.server'

/**
 * Sandbox primitives — workspace + shell. The filesystem ops live in `sandbox-fs.server.ts`
 * and the headless-browser ops in `sandbox-browser.server.ts`. They are re-exported below so
 * existing `import { fileRead, getPage, ... } from './sandbox.server'` callers keep working.
 *
 * Key invariants:
 *   - Every entry point reads `toolUserContext` (an AsyncLocalStorage) to resolve the per-
 *     user/per-run workspace root before touching disk.
 *   - All paths are run through `safePath` so a tool can never read or write outside its
 *     workspace.
 *   - `shellExec` re-roots HOME / TMP / npm caches inside the workspace so sub-processes
 *     can't bleed cache state between users.
 */

const execFileAsync = promisify(execFile)

export type WorktreeStoreConfig = {
	repoPath: string
	baseBranch?: string
	deleteBranchOnCleanup?: boolean
}

/**
 * Per-tool-execution context. The required fields (userId / runId / persistentKey / worktree)
 * resolve the workspace root. The optional `runtime` block is used by tools that need to dispatch
 * nested tool calls — currently only `run_code`, which spawns a sandbox script and proxies tool
 * calls from the script back through `executeToolWithApproval`. Setting it requires the caller to
 * already be inside a chat-loop round (we need the live `Session` to emit `tool_pending` and the
 * approval set to gate which calls require user confirmation).
 */
export const toolUserContext = new AsyncLocalStorage<{
	userId: string
	runId?: string | null
	persistentKey?: string | null
	worktree?: WorktreeStoreConfig | null
	/**
	 * Project ID when the chat run is bound to a project. Used by the workspace resolver
	 * to land the tool's cwd at `<sandbox>/<userId>/projects/<projectId>` and by tools that
	 * default to "this project's repo" when no path is supplied.
	 */
	projectId?: string | null
	runtime?: ToolRuntimeContext | null
}>()

export type ToolRuntimeContext = {
	/** Tool names approved-required for the current run (loop union of user setting + mandatory list). */
	approvalRequiredTools: ReadonlySet<string>
	/** Returns the names of tools currently exposed to the LLM this round. Used by run_code to list available tools to the script. */
	currentToolNames: () => string[]
	/** The live SSE session, when present, so nested tool calls can emit tool_pending / tool_result events. Null in detached/automation runs. */
	session?:
		| {
				emit: (eventName: string, payload: unknown) => Promise<void>
				updateRun: (patch: import('$lib/runtime/types').RunPatch) => Promise<void>
				readonly runId: string
		  }
		| null
	/** Whether this run is the orchestrator (controls run_subagent etc). */
	isOrchestrator?: boolean
	/**
	 * Register tool names to be loaded into the model's tools array on the NEXT round.
	 * Invoked by the `search_tools` handler with the matched tool names. The runtime owns
	 * the actual Set; this is the side-effect channel into it.
	 */
	loadSearchableTools?: (toolNames: string[]) => void
}

export function getWorkspace() {
	const ctx = toolUserContext.getStore()
	if (!ctx?.userId) {
		throw new Error('Missing user context for tool execution')
	}
	return resolveWorkspaceRoot({
		userId: ctx.userId,
		runId: ctx.runId ?? null,
		persistentKey: ctx.persistentKey ?? null,
		worktree: ctx.worktree ?? null,
		projectId: ctx.projectId ?? null,
		sandboxRoot: process.env.SANDBOX_WORKSPACE,
	})
}

export function safePath(userPath: string): string {
	return safePathWithin(getWorkspace(), userPath)
}

export interface ShellOpts {
	cwd?: string
	timeout?: number
	env?: Record<string, string>
}

export async function ensureWorkspaceDir() {
	const ctx = toolUserContext.getStore()
	if (!ctx?.userId) {
		throw new Error('Missing user context for tool execution')
	}
	await ensureWorkspace({
		userId: ctx.userId,
		runId: ctx.runId ?? null,
		persistentKey: ctx.persistentKey ?? null,
		worktree: ctx.worktree ?? null,
		projectId: ctx.projectId ?? null,
		sandboxRoot: process.env.SANDBOX_WORKSPACE,
	})
}

export async function shellExec(command: string, opts: ShellOpts = {}) {
	await ensureWorkspaceDir()
	const workspace = getWorkspace()
	const cwd = opts.cwd ? safePath(opts.cwd) : workspace
	const timeout = opts.timeout ?? 120_000

	// Restrict the shell environment to the sandbox workspace so temp files,
	// home-dir expansion, and npm/bun caches all stay inside the workspace.
	const tmpDir = join(workspace, '.tmp')
	await mkdir(tmpDir, { recursive: true })
	const sandboxEnv: Record<string, string> = {
		// Inherit PATH / system vars only
		PATH: process.env.PATH ?? '',
		SYSTEMROOT: process.env.SYSTEMROOT ?? '',
		SYSTEMDRIVE: process.env.SYSTEMDRIVE ?? '',
		// Redirect all home / temp references into the workspace
		HOME: workspace,
		USERPROFILE: workspace,
		TMPDIR: tmpDir,
		TMP: tmpDir,
		TEMP: tmpDir,
		// Surface the boundary so sub-processes can respect it
		SANDBOX_ROOT: workspace,
		// Prevent npm/bun from writing caches outside workspace
		NPM_CONFIG_CACHE: join(workspace, '.npm-cache'),
		BUN_INSTALL_CACHE_DIR: join(workspace, '.bun-cache'),
		NODE_PATH: '',
		...(opts.env ?? {}),
	}

	try {
		const { stdout, stderr } = await execFileAsync('bun', ['exec', command], {
			cwd,
			timeout,
			maxBuffer: 10 * 1024 * 1024,
			env: sandboxEnv,
		})
		return { exitCode: 0, stdout, stderr }
	} catch (error: unknown) {
		const err = error as {
			code?: number | string
			stdout?: string
			stderr?: string
			message?: string
		}
		if (err.code === 'ETIMEDOUT' || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
			return {
				exitCode: 124,
				stdout: err.stdout ?? '',
				stderr: err.stderr ?? `Command timed out after ${timeout}ms`,
			}
		}
		return {
			exitCode: typeof err.code === 'number' ? err.code : 1,
			stdout: err.stdout ?? '',
			stderr: err.stderr ?? err.message ?? 'Command failed',
		}
	}
}

// Re-export filesystem + browser primitives so existing imports from './sandbox.server'
// keep working without churning every caller.
export {
	fileRead,
	fileReadRange,
	fileWrite,
	fileDelete,
	fileMove,
	fileList,
	sandboxFileInfo,
	fileSearch,
	fileStrReplace,
	filePatch,
	type FileReadOpts,
	type FileListOpts,
	type FileSearchOpts,
	type FileReplaceOpts,
} from './sandbox-fs.server'

export {
	getPage,
	sandboxBrowserNavigate,
	sandboxBrowserScreenshot,
	browserClose,
} from './sandbox-browser.server'
