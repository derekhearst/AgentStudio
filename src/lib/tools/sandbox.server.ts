import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import {
	access,
	mkdir,
	readdir,
	readFile as fsRead,
	rename as fsRename,
	rm,
	stat,
	writeFile as fsWrite,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Browser, Page } from 'playwright'
import { resolveWorkspaceRoot, safePathWithin, ensureWorkspace } from '$lib/workspace/workspace.server'

/**
 * Sandbox primitives — workspace, shell, filesystem, and headless-browser
 * helpers shared by the public tool wrappers and `executeTool` dispatch.
 *
 * Key invariants:
 *   - Every entry point reads `toolUserContext` (an AsyncLocalStorage) to
 *     resolve the per-user/per-run workspace root before touching disk.
 *   - All paths are run through `safePath` so a tool can never read or
 *     write outside its workspace.
 *   - `shellExec` re-roots HOME / TMP / npm caches inside the workspace so
 *     sub-processes can't bleed cache state between users.
 */


const execFileAsync = promisify(execFile)

let browser: Browser | null = null
let page: Page | null = null

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
		const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string }
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

export async function fileRead(path: string) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	return fsRead(fullPath, 'utf-8')
}

export interface FileReadOpts {
	startLine?: number
	endLine?: number
}

export async function fileReadRange(path: string, opts: FileReadOpts = {}) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	const content = await fsRead(fullPath, 'utf-8')

	if (opts.startLine === undefined && opts.endLine === undefined) {
		return content
	}

	const start = opts.startLine ?? 1
	const end = opts.endLine ?? Number.MAX_SAFE_INTEGER
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
		throw new Error('Invalid line range: startLine/endLine must be positive integers and endLine >= startLine')
	}

	const lines = content.split(/\r?\n/)
	return lines.slice(start - 1, end).join('\n')
}

export async function fileWrite(path: string, content: string) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	await mkdir(resolve(fullPath, '..'), { recursive: true })
	await fsWrite(fullPath, content, 'utf-8')
}

export async function fileDelete(path: string, recursive = false) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	const info = await stat(fullPath)
	if (info.isDirectory() && !recursive) {
		throw new Error('Path is a directory. Set recursive=true to delete directories.')
	}
	await rm(fullPath, { recursive, force: true })
}

export async function fileMove(fromPath: string, toPath: string, overwrite = false) {
	await ensureWorkspaceDir()
	const source = safePath(fromPath)
	const target = safePath(toPath)
	await mkdir(dirname(target), { recursive: true })

	if (!overwrite) {
		try {
			await access(target)
			throw new Error(`Target already exists: ${toPath}`)
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Target already exists:')) {
				throw error
			}
		}
	} else {
		await rm(target, { recursive: true, force: true }).catch(() => {})
	}

	await fsRename(source, target)
	return { fromPath, toPath }
}

export interface FileListOpts {
	depth?: number
	includeHidden?: boolean
	maxEntries?: number
}

export async function fileList(path?: string, opts: FileListOpts = {}) {
	await ensureWorkspaceDir()
	const root = path ? safePath(path) : getWorkspace()
	const depth = opts.depth ?? 1
	const includeHidden = opts.includeHidden ?? false
	const maxEntries = opts.maxEntries ?? 1000

	if (!Number.isInteger(depth) || depth < 0) {
		throw new Error('Invalid depth: must be a non-negative integer')
	}

	const out: Array<{ path: string; name: string; isDirectory: boolean; size: number; modified: string }> = []

	async function walk(current: string, currentDepth: number) {
		if (out.length >= maxEntries) return
		const entries = await readdir(current)

		for (const name of entries) {
			if (!includeHidden && name.startsWith('.')) continue
			if (!includeHidden && (name === 'node_modules' || name === 'build')) continue

			const full = join(current, name)
			const s = await stat(full)
			const relPath = relative(getWorkspace(), full).replace(/\\/g, '/')

			out.push({
				path: relPath,
				name,
				isDirectory: s.isDirectory(),
				size: s.size,
				modified: s.mtime.toISOString(),
			})

			if (out.length >= maxEntries) return
			if (s.isDirectory() && currentDepth < depth) {
				await walk(full, currentDepth + 1)
			}
		}
	}

	await walk(root, 0)
	return out
}

export async function sandboxFileInfo(path: string) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	const s = await stat(fullPath)
	return {
		path,
		isDirectory: s.isDirectory(),
		isFile: s.isFile(),
		size: s.size,
		modified: s.mtime.toISOString(),
		created: s.ctime.toISOString(),
		permissions: (s.mode & 0o777).toString(8),
	}
}

export interface FileSearchOpts {
	path?: string
	maxResults?: number
	isRegex?: boolean
	includeIgnored?: boolean
	caseSensitive?: boolean
}

export async function fileSearch(query: string, opts: FileSearchOpts = {}) {
	await ensureWorkspaceDir()
	const searchPath = opts.path ? safePath(opts.path) : getWorkspace()
	const maxResults = opts.maxResults ?? 50
	const flags = [
		'--line-number',
		'--with-filename',
		'--color=never',
		`--max-count=${maxResults}`,
		'--max-columns=300',
		'--max-columns-preview',
	]

	if (!opts.caseSensitive) flags.push('-i')
	if (!opts.isRegex) flags.push('--fixed-strings')
	if (opts.includeIgnored) {
		flags.push('--hidden', '--no-ignore-vcs', '--no-ignore')
		flags.push('-g', '!node_modules/**')
	}

	const command = `rg ${flags.join(' ')} ${JSON.stringify(query)} ${JSON.stringify(searchPath)}`
	const result = await shellExec(command)

	if (result.exitCode !== 0 && result.exitCode !== 1) {
		throw new Error(result.stderr || 'Search failed')
	}

	if (!result.stdout.trim()) return []

	return result.stdout
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [filePath, lineNo, ...rest] = line.split(':')
			return {
				path: relative(getWorkspace(), filePath).replace(/\\/g, '/'),
				line: Number(lineNo),
				preview: rest.join(':').trim(),
			}
		})
}

export interface FileReplaceOpts {
	requireUnique?: boolean
	replaceAll?: boolean
}

export async function fileStrReplace(path: string, oldStr: string, newStr: string, opts: FileReplaceOpts = {}) {
	if (!oldStr) {
		throw new Error('oldStr must not be empty')
	}

	const fullPath = safePath(path)
	const content = await fsRead(fullPath, 'utf-8')
	const matchCount = content.split(oldStr).length - 1

	if (matchCount === 0) {
		throw new Error('oldStr was not found in file')
	}

	const requireUnique = opts.requireUnique ?? true
	const replaceAll = opts.replaceAll ?? false

	if (requireUnique && matchCount !== 1) {
		throw new Error(`Expected exactly 1 match for oldStr, found ${matchCount}`)
	}

	let updated = content
	let replacedCount = 0
	if (replaceAll || (!requireUnique && matchCount > 1)) {
		updated = content.split(oldStr).join(newStr)
		replacedCount = matchCount
	} else {
		updated = content.replace(oldStr, newStr)
		replacedCount = 1
	}

	await fsWrite(fullPath, updated, 'utf-8')
	return { path, replacedCount, matchCount }
}

export async function filePatch(patch: string) {
	if (!patch.trim()) {
		throw new Error('Patch must not be empty')
	}

	const tmpPatch = join(tmpdir(), `sandbox_patch_${Date.now()}_${Math.random().toString(36).slice(2)}.diff`)
	await fsWrite(tmpPatch, patch, 'utf-8')

	try {
		const result = await shellExec(
			`git apply --no-index --whitespace=nowarn --recount --unidiff-zero ${JSON.stringify(tmpPatch)}`,
		)
		if (result.exitCode !== 0) {
			throw new Error(result.stderr || result.stdout || 'Failed to apply patch')
		}
		return { success: true }
	} finally {
		await rm(tmpPatch, { force: true }).catch(() => {})
	}
}

export async function getPage(): Promise<Page> {
	if (page && !page.isClosed()) return page

	if (!browser || !browser.isConnected()) {
		const { chromium } = await import('playwright')
		const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
		browser = await chromium.launch({
			headless: true,
			executablePath,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
		})
	}

	page = await browser.newPage()
	return page
}

export async function sandboxBrowserNavigate(url: string) {
	const p = await getPage()
	await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
	return { title: await p.title(), url: p.url() }
}

export async function sandboxBrowserScreenshot(): Promise<Buffer> {
	const p = await getPage()
	return (await p.screenshot({ type: 'png', fullPage: false })) as Buffer
}

export async function browserClose() {
	if (page && !page.isClosed()) {
		await page.close().catch(() => {})
	}
	page = null
	if (browser && browser.isConnected()) {
		await browser.close().catch(() => {})
	}
	browser = null
}
