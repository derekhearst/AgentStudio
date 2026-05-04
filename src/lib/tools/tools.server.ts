import { z } from 'zod'
import { env } from '$env/dynamic/private'
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
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Browser, Page } from 'playwright'
import { promisify } from 'node:util'
import { db } from '$lib/db.server'
import { eq } from 'drizzle-orm'
import { requireAdminRequestUser, normalizeUsername } from '$lib/auth/auth.server'
import { users } from '$lib/auth/auth.schema'
import { setAgentStatus, updateAgentRecord } from '$lib/agents/agents.server'
import { resolveWorkspaceRoot, safePathWithin, ensureWorkspace } from '$lib/workspace/workspace.server'
import { logToolUsage } from '$lib/costs/usage'
import {
	createAutomationRecord,
	deleteAutomationRecord,
	listAutomationsForUser,
	updateAutomationRecord,
} from '$lib/automations/automation.server'
import {
	listSkillSummaries,
	getSkillByName,
	getSkillFileByName,
	createSkill,
	updateSkill as updateSkillRecord,
	deleteSkill as deleteSkillRecord,
	addSkillFile,
	updateSkillFile as updateSkillFileRecord,
	deleteSkillFile as deleteSkillFileRecord,
	bumpSkillAccess,
} from '$lib/skills/skills.server'

type SearchResult = {
	title: string
	url: string
	snippet: string
	engine?: string
	score?: number
}

type ImageModel = 'flux' | 'sdxl' | 'dall-e'
type ImageSize = '256x256' | '512x512' | '1024x1024'

type ImageResult = {
	url: string
	model: string
	size: string
	prompt: string
	cost: number
}

const MODEL_MAP: Record<ImageModel, string> = {
	flux: 'black-forest-labs/flux-1-schnell',
	sdxl: 'stabilityai/stable-diffusion-xl-base-1.0',
	'dall-e': 'openai/dall-e-3',
}

const execFileAsync = promisify(execFile)

let browser: Browser | null = null
let page: Page | null = null

type WorktreeStoreConfig = {
	repoPath: string
	baseBranch?: string
	deleteBranchOnCleanup?: boolean
}

const toolUserContext = new AsyncLocalStorage<{
	userId: string
	runId?: string | null
	persistentKey?: string | null
	worktree?: WorktreeStoreConfig | null
}>()

/**
 * Wave 4 #15 phase 2 finish — resolve the conversation that a tool call belongs to via
 * the runId in the AsyncLocalStorage context. Used by set_project_context to know which
 * `conversations` row to update. Returns null when there's no run-context (e.g. a tool
 * call from a one-shot synthesis path that bypasses chat_runs).
 */
async function resolveConversationFromRunId(runId: string | null): Promise<string | null> {
	if (!runId) return null
	try {
		const { chatRuns } = await import('$lib/runs/runs.schema')
		const { eq } = await import('drizzle-orm')
		const [row] = await db
			.select({ conversationId: chatRuns.conversationId })
			.from(chatRuns)
			.where(eq(chatRuns.id, runId))
			.limit(1)
		return row?.conversationId ?? null
	} catch (err) {
		console.warn('[tools] resolveConversationFromRunId failed', err)
		return null
	}
}

function getWorkspace() {
	const ctx = toolUserContext.getStore()
	if (!ctx?.userId) {
		throw new Error('Missing user context for tool execution')
	}
	return resolveWorkspaceRoot({
		userId: ctx.userId,
		runId: ctx.runId ?? null,
		persistentKey: ctx.persistentKey ?? null,
		worktree: ctx.worktree ?? null,
		sandboxRoot: env.SANDBOX_WORKSPACE,
	})
}

function safePath(userPath: string): string {
	return safePathWithin(getWorkspace(), userPath)
}

interface ShellOpts {
	cwd?: string
	timeout?: number
	env?: Record<string, string>
}

async function ensureWorkspaceDir() {
	const ctx = toolUserContext.getStore()
	if (!ctx?.userId) {
		throw new Error('Missing user context for tool execution')
	}
	await ensureWorkspace({
		userId: ctx.userId,
		runId: ctx.runId ?? null,
		persistentKey: ctx.persistentKey ?? null,
		worktree: ctx.worktree ?? null,
		sandboxRoot: env.SANDBOX_WORKSPACE,
	})
}

async function shellExec(command: string, opts: ShellOpts = {}) {
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

async function fileRead(path: string) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	return fsRead(fullPath, 'utf-8')
}

interface FileReadOpts {
	startLine?: number
	endLine?: number
}

async function fileReadRange(path: string, opts: FileReadOpts = {}) {
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

async function fileWrite(path: string, content: string) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	await mkdir(resolve(fullPath, '..'), { recursive: true })
	await fsWrite(fullPath, content, 'utf-8')
}

async function fileDelete(path: string, recursive = false) {
	await ensureWorkspaceDir()
	const fullPath = safePath(path)
	const info = await stat(fullPath)
	if (info.isDirectory() && !recursive) {
		throw new Error('Path is a directory. Set recursive=true to delete directories.')
	}
	await rm(fullPath, { recursive, force: true })
}

async function fileMove(fromPath: string, toPath: string, overwrite = false) {
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

interface FileListOpts {
	depth?: number
	includeHidden?: boolean
	maxEntries?: number
}

async function fileList(path?: string, opts: FileListOpts = {}) {
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

async function sandboxFileInfo(path: string) {
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

interface FileSearchOpts {
	path?: string
	maxResults?: number
	isRegex?: boolean
	includeIgnored?: boolean
	caseSensitive?: boolean
}

async function fileSearch(query: string, opts: FileSearchOpts = {}) {
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

interface FileReplaceOpts {
	requireUnique?: boolean
	replaceAll?: boolean
}

async function fileStrReplace(path: string, oldStr: string, newStr: string, opts: FileReplaceOpts = {}) {
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

async function filePatch(patch: string) {
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

async function getPage(): Promise<Page> {
	if (page && !page.isClosed()) return page

	if (!browser || !browser.isConnected()) {
		const { chromium } = await import('playwright')
		const executablePath = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined
		browser = await chromium.launch({
			headless: true,
			executablePath,
			args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
		})
	}

	page = await browser.newPage()
	return page
}

async function sandboxBrowserNavigate(url: string) {
	const p = await getPage()
	await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
	return { title: await p.title(), url: p.url() }
}

async function sandboxBrowserScreenshot(): Promise<Buffer> {
	const p = await getPage()
	return (await p.screenshot({ type: 'png', fullPage: false })) as Buffer
}

async function browserClose() {
	if (page && !page.isClosed()) {
		await page.close().catch(() => {})
	}
	page = null
	if (browser && browser.isConnected()) {
		await browser.close().catch(() => {})
	}
	browser = null
}

function buildAuthHeader() {
	if (!env.SEARXNG_PASSWORD) return undefined
	const username = env.SEARXNG_USERNAME || 'derek'
	const token = Buffer.from(`${username}:${env.SEARXNG_PASSWORD}`).toString('base64')
	return `Basic ${token}`
}

export async function webSearch(query: string, limit = 8): Promise<SearchResult[]> {
	if (!env.SEARXNG_URL) {
		throw new Error('SEARXNG_URL is not configured')
	}

	const url = new URL('/search', env.SEARXNG_URL)
	url.searchParams.set('q', query)
	url.searchParams.set('format', 'json')

	const authHeader = buildAuthHeader()
	const response = await fetch(url, {
		headers: authHeader ? { Authorization: authHeader } : undefined,
	})

	if (!response.ok) {
		throw new Error(`SearXNG request failed with status ${response.status}`)
	}

	const payload = (await response.json()) as {
		results?: Array<{ title?: string; url?: string; content?: string; engine?: string; score?: number }>
	}

	const normalized = (payload.results ?? [])
		.filter((entry) => Boolean(entry.url))
		.map((entry) => ({
			title: entry.title || 'Untitled',
			url: entry.url || '',
			snippet: entry.content || '',
			engine: entry.engine,
			score: entry.score,
		}))

	return normalized.slice(0, limit)
}

export async function generateImage(
	prompt: string,
	model: ImageModel = 'flux',
	size: ImageSize = '1024x1024',
): Promise<ImageResult> {
	if (!env.OPENROUTER_API_KEY) {
		throw new Error('OPENROUTER_API_KEY is not set')
	}

	const response = await fetch('https://openrouter.ai/api/v1/images/generations', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: MODEL_MAP[model],
			prompt,
			n: 1,
			size,
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Image generation failed (${response.status}): ${text}`)
	}

	const data = (await response.json()) as {
		data?: Array<{ url?: string; b64_json?: string }>
		usage?: { total_cost?: number }
	}

	const imageUrl = data.data?.[0]?.url
	if (!imageUrl) {
		throw new Error('No image URL returned from generation API')
	}

	return {
		url: imageUrl,
		model: MODEL_MAP[model],
		size,
		prompt,
		cost: data.usage?.total_cost ?? 0,
	}
}

export async function execShell(command: string) {
	const result = await shellExec(command)
	return {
		success: result.exitCode === 0,
		command,
		status: result.exitCode === 0 ? 'completed' : 'failed',
		exitCode: result.exitCode,
		output: result.stdout + (result.stderr ? `\n${result.stderr}` : ''),
		raw: result,
	}
}

export async function readFile(path: string, startLine?: number, endLine?: number) {
	const content =
		startLine !== undefined || endLine !== undefined
			? await fileReadRange(path, { startLine, endLine })
			: await fileRead(path)
	return { path, content }
}

export async function writeFile(path: string, content: string) {
	await fileWrite(path, content)
	return {
		success: true,
		path,
		message: `File written (${content.length} chars)`,
	}
}

export async function patchFile(patch: string) {
	return filePatch(patch)
}

export async function replaceInFile(
	path: string,
	oldStr: string,
	newStr: string,
	options?: { requireUnique?: boolean; replaceAll?: boolean },
) {
	return fileStrReplace(path, oldStr, newStr, options)
}

export async function listDirectory(path?: string, depth = 1, includeHidden = false) {
	return fileList(path, { depth, includeHidden })
}

export async function deleteFile(path: string, recursive = false) {
	await fileDelete(path, recursive)
	return { success: true, path, recursive }
}

export async function moveFile(fromPath: string, toPath: string, overwrite = false) {
	const result = await fileMove(fromPath, toPath, overwrite)
	return { success: true, ...result }
}

export async function searchFiles(
	query: string,
	options?: {
		path?: string
		maxResults?: number
		isRegex?: boolean
		includeIgnored?: boolean
		caseSensitive?: boolean
	},
) {
	return fileSearch(query, options)
}

export async function fileInfo(path: string) {
	return sandboxFileInfo(path)
}

export async function browserNavigate(url: string) {
	const result = await sandboxBrowserNavigate(url)
	return {
		success: true,
		url: result.url,
		title: result.title,
	}
}

export async function browserScreenshot(url?: string) {
	if (url) {
		await sandboxBrowserNavigate(url)
	}
	const buffer = await sandboxBrowserScreenshot()
	return {
		mimeType: 'image/png',
		imageBase64: buffer.toString('base64'),
	}
}

/**
 * Wave 4 #18 phase 1 — `web_fetch` tool implementation.
 *
 * Reuses the existing Playwright browser singleton (same one `browser_screenshot` uses) so we
 * don't fight over chromium processes. Returns the page's text content trimmed to maxChars.
 *
 * SAFETY: URL goes through `validateFetchUrl` BEFORE the network call so private/loopback
 * addresses are blocked at the boundary (SSRF defense). Also wraps the navigate in a 30s
 * timeout — sites that hang past that fail rather than tying up the worker indefinitely.
 *
 * Boilerplate strip + paragraph-boundary truncation are pure helpers in `$lib/research/web-fetch`
 * so the URL safety contract is testable without booting Playwright.
 */
export async function webFetch(rawUrl: string, maxChars = 50_000) {
	const { validateFetchUrl, cleanupExtractedText, truncateAtParagraph } = await import('$lib/research/web-fetch')
	const validation = validateFetchUrl(rawUrl)
	if (!validation.ok) {
		throw new Error(validation.error)
	}
	const targetUrl = validation.url.toString()
	const p = await getPage()
	await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
	// Best-effort: also wait for network to settle briefly so SPA pages have time to render.
	await p.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined)

	const title = await p.title().catch(() => '')
	const finalUrl = p.url()
	const rawText = (await p.textContent('body').catch(() => '')) ?? ''
	const cleaned = cleanupExtractedText(rawText)
	const text = truncateAtParagraph(cleaned, maxChars)

	return {
		title,
		url: finalUrl,
		text,
		fetchedAt: new Date().toISOString(),
		fullCharCount: cleaned.length,
		truncated: cleaned.length > maxChars,
	}
}

export async function getSandboxStatus() {
	const workspace = env.SANDBOX_WORKSPACE || '/workspace'
	try {
		const s = await stat(workspace)
		return {
			success: s.isDirectory(),
			message: s.isDirectory() ? 'Sandbox workspace accessible' : 'Sandbox workspace path is not a directory',
			stats: { workspace, isDirectory: s.isDirectory() },
		}
	} catch {
		return {
			success: false,
			message: `Sandbox workspace not found: ${workspace}`,
			stats: null,
		}
	}
}

export { browserClose }

export const toolSchemas = {
	web_search: z.object({ query: z.string().min(1) }),
	shell: z.object({ command: z.string().min(1) }),
	file_read: z.object({
		path: z.string().min(1),
		startLine: z.number().int().min(1).optional(),
		endLine: z.number().int().min(1).optional(),
	}),
	file_write: z.object({ path: z.string().min(1), content: z.string() }),
	file_patch: z.object({ patch: z.string().min(1) }),
	file_replace: z.object({
		path: z.string().min(1),
		oldStr: z.string().min(1),
		newStr: z.string(),
		requireUnique: z.boolean().default(true),
		replaceAll: z.boolean().default(false),
	}),
	list_directory: z.object({
		path: z.string().min(1).optional(),
		depth: z.number().int().min(0).max(6).default(1),
		includeHidden: z.boolean().default(false),
	}),
	delete_file: z.object({ path: z.string().min(1), recursive: z.boolean().default(false) }),
	move_file: z.object({
		fromPath: z.string().min(1),
		toPath: z.string().min(1),
		overwrite: z.boolean().default(false),
	}),
	search_files: z.object({
		query: z.string().min(1),
		path: z.string().min(1).optional(),
		maxResults: z.number().int().min(1).max(200).default(50),
		isRegex: z.boolean().default(false),
		includeIgnored: z.boolean().default(false),
		caseSensitive: z.boolean().default(false),
	}),
	file_info: z.object({ path: z.string().min(1) }),
	browser_screenshot: z.object({ url: z.string().url().optional() }),
	web_fetch: z.object({
		url: z.string().min(1).max(2048),
		maxChars: z.number().int().min(1000).max(100_000).default(50_000).optional(),
	}),
	// Wave 4 #15 phase 2 — Projects + Artifacts agent tools.
	list_projects: z.object({}),
	create_project: z.object({
		name: z.string().trim().min(1).max(120),
		kind: z.enum(['efoil', 'research', 'code', 'documentation', 'other']).optional(),
		description: z.string().trim().max(1000).optional(),
	}),
	list_artifacts: z.object({
		projectId: z.string().uuid(),
		includeInactive: z.boolean().default(false).optional(),
	}),
	read_artifact: z.object({
		artifactId: z.string().uuid(),
	}),
	create_artifact: z.object({
		projectId: z.string().uuid(),
		name: z.string().trim().min(1).max(160),
		content: z.string(),
		contentType: z.enum(['markdown', 'code', 'json', 'yaml', 'plaintext']).optional(),
		changeNote: z.string().trim().max(500).optional(),
	}),
	edit_artifact: z.object({
		artifactId: z.string().uuid(),
		content: z.string(),
		changeNote: z.string().trim().max(500).optional(),
	}),
	// Wave 4 #15 phase 2 finish — bind a project to the current conversation so subsequent
	// edits target the right project by default. Pass projectId=null (or omit) to unbind.
	set_project_context: z.object({
		projectId: z.string().uuid().nullable().optional(),
	}),
	run_subagent: z.object({
		task: z.string().min(1),
		context: z.string().optional(),
		agentId: z.string().uuid().optional(),
	}),
	image_generate: z.object({
		prompt: z.string().min(1).max(2000),
		model: z.enum(['flux', 'sdxl', 'dall-e']).default('flux'),
		size: z.enum(['256x256', '512x512', '1024x1024']).default('1024x1024'),
	}),
	update_agent: z.object({
		agentId: z.string().uuid(),
		name: z.string().min(1).max(120).optional(),
		role: z.string().min(1).max(240).optional(),
		systemPrompt: z.string().min(1).optional(),
		model: z.string().min(1).max(120).optional(),
	}),
	pause_agent: z.object({
		agentId: z.string().uuid(),
	}),
	resume_agent: z.object({
		agentId: z.string().uuid(),
	}),
	create_user: z.object({
		username: z.string().min(3).max(32),
		name: z.string().min(1).max(64).optional(),
		role: z.enum(['admin', 'user']).default('user'),
	}),
	create_automation: z.object({
		agentId: z.string().uuid().nullable().optional(),
		description: z.string().min(1).max(200),
		cronExpression: z.string().min(1).max(120),
		prompt: z.string().min(1),
		enabled: z.boolean().default(true),
		conversationMode: z.enum(['new_each_run', 'reuse']).default('new_each_run'),
	}),
	list_automations: z.object({}),
	update_automation: z.object({
		automationId: z.string().uuid(),
		agentId: z.string().uuid().nullable().optional(),
		description: z.string().min(1).max(200).optional(),
		cronExpression: z.string().min(1).max(120).optional(),
		prompt: z.string().min(1).optional(),
		enabled: z.boolean().optional(),
		conversationMode: z.enum(['new_each_run', 'reuse']).optional(),
	}),
	delete_automation: z.object({
		automationId: z.string().uuid(),
	}),
	ask_user: z.object({
		questions: z
			.array(
				z.object({
					header: z.string().min(1),
					question: z.string().min(1),
					options: z
						.array(
							z.object({
								label: z.string().min(1),
								description: z.string().optional(),
								recommended: z.boolean().optional(),
							}),
						)
						.default([]),
					allowFreeformInput: z.boolean().default(true),
				}),
			)
			.min(1)
			.max(8),
	}),
	list_skills: z.object({}),
	read_skill: z.object({ name: z.string().min(1) }),
	read_skill_file: z.object({ skillName: z.string().min(1), fileName: z.string().min(1) }),
	create_skill: z.object({
		name: z.string().min(1).max(100),
		description: z.string().min(1).max(500),
		content: z.string().min(1),
		tags: z.array(z.string()).optional(),
	}),
	update_skill: z.object({
		name: z.string().min(1),
		description: z.string().min(1).max(500).optional(),
		content: z.string().min(1).optional(),
		tags: z.array(z.string()).optional(),
	}),
	add_skill_file: z.object({
		skillName: z.string().min(1),
		fileName: z.string().min(1).max(200),
		description: z.string().max(500).default(''),
		content: z.string().min(1),
	}),
	update_skill_file: z.object({
		skillName: z.string().min(1),
		fileName: z.string().min(1),
		content: z.string().min(1).optional(),
		description: z.string().max(500).optional(),
	}),
	delete_skill: z.object({ name: z.string().min(1) }),
	delete_skill_file: z.object({ skillName: z.string().min(1), fileName: z.string().min(1) }),
	git_status: z.object({}),
	git_log: z.object({
		max: z.number().int().min(1).max(200).default(20),
		paths: z.array(z.string().min(1)).optional(),
	}),
	git_diff: z.object({
		ref: z.string().min(1).optional(),
		paths: z.array(z.string().min(1)).optional(),
		staged: z.boolean().default(false),
	}),
	enable_capability: z.object({
		group: z.enum(['core', 'sandbox', 'skills', 'agents', 'media']),
	}),
	propose_plan: z.object({
		summary: z.string().min(1).max(500),
		steps: z
			.array(
				z.object({
					title: z.string().min(1).max(200),
					detail: z.string().max(1000).optional(),
					estimatedDurationMin: z.number().int().positive().max(10_000).optional(),
					estimatedCostUsd: z.number().nonnegative().max(1000).optional(),
					blastRadius: z.enum(['local', 'shared', 'production']).optional(),
					reversible: z.boolean().optional(),
				}),
			)
			.min(1)
			.max(20),
		risks: z.array(z.string().min(1).max(280)).max(10).optional(),
		rollback: z.string().max(1000).optional(),
		totalEstimatedCostUsd: z.number().nonnegative().max(1000).optional(),
		totalEstimatedDurationMin: z.number().int().positive().max(10_000).optional(),
	}),
}

export type ToolName = keyof typeof toolSchemas

export const allToolNames = Object.keys(toolSchemas) as ToolName[]

const toolDescriptions: Record<ToolName, string> = {
	web_search: 'Search the web for information.',
	shell: 'Run a shell command in the sandboxed environment.',
	file_read: 'Read a file from the sandbox filesystem, optionally by line range.',
	file_write: 'Write content to a file in the sandbox filesystem.',
	file_patch: 'Apply a unified diff patch to files in the sandbox workspace.',
	file_replace:
		'Replace an exact string in a file. By default requires exactly one match, making edits deterministic and retry-safe.',
	list_directory: 'List files and directories with depth and hidden-file controls.',
	delete_file: 'Delete a file or directory (recursive deletes require explicit recursive=true).',
	move_file: 'Move or rename a file/directory within the sandbox workspace.',
	search_files: 'Search file contents in the workspace (ripgrep-style) with optional regex and ignore controls.',
	file_info: 'Get file or directory metadata (size, modified time, permissions).',
	browser_screenshot: 'Take a screenshot of a web page.',
	web_fetch: 'Fetch the full text content of a web page (HTTP/HTTPS only). Returns { title, url, text, fetchedAt } with the body text trimmed to maxChars (default 50,000). Blocks private/loopback addresses to prevent SSRF. Use this when web_search snippets are insufficient and you need to read the actual page content.',
	list_projects: 'List the user\'s projects (durable containers for artifacts with append-only version history). Returns id, name, slug, kind, description for each project.',
	create_project: 'Create a new project to group related artifacts. Slug auto-generated from name + deduped per-user. Kinds: efoil/research/code/documentation/other.',
	list_artifacts: 'List artifacts in a project. Returns id, name, slug, contentType, isActive for each artifact (active by default; pass includeInactive to see soft-deleted).',
	read_artifact: 'Read an artifact\'s current version content. Returns name, contentType, version seq, content, and the artifact\'s project info. Use to load an artifact before editing.',
	create_artifact: 'Create a new artifact in a project (saves the initial content as v1). Slug auto-generated from name. Optional changeNote describes what this initial version contains.',
	edit_artifact: 'Append a new version to an existing artifact (append-only, preserves the full history). Optional changeNote describes what changed in this version. Use read_artifact first to see the current content.',
	set_project_context: 'Bind a project to the current conversation so subsequent agent edits know which project to target by default. Pass projectId=null (or omit) to unbind. The bound project shows up in the conversation\'s system-prompt context slot so the agent has continuous awareness of which project is "in scope".',
	run_subagent:
		'Run a subagent to handle a task. Optionally specify agentId to delegate to a specific agent. Without agentId, uses a general-purpose stateless subagent.',
	image_generate: 'Generate an image from a text prompt.',
	update_agent: 'Update an existing agent fields such as name, role, model, or system prompt.',
	pause_agent: 'Pause an agent so it is not used for delegations.',
	resume_agent: 'Resume a paused agent and mark it active again.',
	create_user: 'Create a user account (admin-only tool).',
	create_automation: 'Create a recurring automation that triggers an agent prompt on a cron schedule.',
	list_automations: 'List automations for the current user.',
	update_automation: 'Update an existing automation schedule, prompt, mode, or enabled state.',
	delete_automation: 'Delete an automation by id.',
	ask_user:
		'Ask the user one or more focused clarifying questions with prefilled answer options. Each question should have ~3 prefilled options — prefer splitting a broad inquiry into multiple focused questions rather than providing many options in a single question. Use when you need explicit user input before proceeding.',
	list_skills:
		'List all available skills with their names, descriptions, and nested file names. Use this to discover what skills are available.',
	read_skill:
		'Read a skill by name. Returns the main content and a list of available nested files. Use this when a skill is relevant to the current task.',
	read_skill_file: 'Read a specific nested file within a skill. Use after read_skill to load additional context files.',
	create_skill:
		'Create a new skill with a name, description, and main content. Skills are reusable instruction/knowledge bundles. Keep main content under 8KB.',
	update_skill: 'Update an existing skill by name. Can modify description, content, or tags.',
	add_skill_file:
		'Add a nested file to an existing skill. Files provide optional additional context (e.g., examples, sub-topics).',
	update_skill_file: 'Update a nested file within a skill by skill name and file name.',
	delete_skill: 'Delete a skill and all its nested files by name.',
	delete_skill_file: 'Delete a specific nested file from a skill.',
	git_status:
		'Show the working tree status (`git status --porcelain=v1`). Read-only; only available when the workspace is a git worktree (Phase 4 of #7). Returns the list of changed/untracked files.',
	git_log:
		'Show recent commits with subject, author, and date (read-only). Optional `paths` filter scopes the log to specific files. Only available in worktree mode.',
	git_diff:
		'Show diff between the working tree and `ref` (default: HEAD), or `--staged` against the index. Optional `paths` filter scopes the diff. Read-only; worktree mode only.',
	propose_plan:
		'Propose a structured execution plan to the user with ordered steps, estimated cost/time, risks, and rollback. The user explicitly approves or denies before you call any non-readonly tool. Required in plan mode; should be called before taking any destructive or expensive action.',
	enable_capability:
		'Enable a capability group (sandbox / skills / agents / media) so its tools become available on the next round. Use this when the task clearly needs filesystem operations, skill management, agent delegation, or image generation. The active surface starts with only the `core` group; expand on demand to keep the prompt slim.',
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema) as Record<string, unknown>
}

/**
 * Wave 2 #11 phase 2 helper — render a propose_plan input as markdown for the parent task's
 * `spec` column. This is the durable, human-readable description of what the orchestrator
 * committed to; the structured fields stay on the task's metadata for programmatic use.
 */
type ProposePlanInput = z.infer<typeof toolSchemas.propose_plan>
function stringifyPlanForSpec(plan: ProposePlanInput): string {
	const lines: string[] = []
	lines.push(`# ${plan.summary}`, '')
	lines.push('## Steps', '')
	plan.steps.forEach((step, idx) => {
		lines.push(`${idx + 1}. **${step.title}**`)
		if (step.detail) lines.push(`   ${step.detail}`)
		const meta: string[] = []
		if (step.estimatedDurationMin !== undefined) meta.push(`~${step.estimatedDurationMin}m`)
		if (step.estimatedCostUsd !== undefined) meta.push(`$${step.estimatedCostUsd.toFixed(2)}`)
		if (step.blastRadius) meta.push(step.blastRadius)
		if (step.reversible === false) meta.push('irreversible')
		if (meta.length > 0) lines.push(`   _(${meta.join(' · ')})_`)
	})
	if (plan.risks?.length) {
		lines.push('', '## Risks', ...plan.risks.map((r) => `- ${r}`))
	}
	if (plan.rollback) {
		lines.push('', '## Rollback', plan.rollback)
	}
	if (plan.totalEstimatedCostUsd !== undefined || plan.totalEstimatedDurationMin !== undefined) {
		const totals: string[] = []
		if (plan.totalEstimatedDurationMin !== undefined) totals.push(`~${plan.totalEstimatedDurationMin}m`)
		if (plan.totalEstimatedCostUsd !== undefined) totals.push(`$${plan.totalEstimatedCostUsd.toFixed(2)}`)
		lines.push('', `_Total: ${totals.join(' · ')}_`)
	}
	return lines.join('\n')
}

/**
 * Returns tool definitions for the LLM.
 * When `onlyTools` is provided, only those tools are included (capability filtering).
 * When omitted, all tools are returned (backwards compatible).
 */
export function getToolDefinitions(onlyTools?: ToolName[]) {
	const entries = onlyTools
		? Object.entries(toolSchemas).filter(([name]) => onlyTools.includes(name as ToolName))
		: Object.entries(toolSchemas)

	return entries.map(([name, schema]) => ({
		type: 'function' as const,
		function: {
			name,
			description: toolDescriptions[name as ToolName],
			parameters: zodToJsonSchema(schema),
		},
	}))
}

export type ToolCall = {
	name: ToolName
	arguments: unknown
}

export type ToolCallWithContext = ToolCall & {
	conversationId?: string | null
	messageId?: string | null
}

function normalizeToolName(name: string): ToolName | null {
	const trimmed = name.trim()
	if (trimmed in toolSchemas) return trimmed as ToolName
	const normalized = trimmed.toLowerCase().replace(/[\s-]+/g, '_')
	if (normalized in toolSchemas) return normalized as ToolName
	return null
}

export type WorkspaceOptions = {
	persistentKey?: string | null
	worktree?: WorktreeStoreConfig | null
}

export async function executeTool(
	call: ToolCall,
	userId: string,
	runId?: string | null,
	workspace?: WorkspaceOptions,
) {
	return toolUserContext.run(
		{
			userId,
			runId: runId ?? null,
			persistentKey: workspace?.persistentKey ?? null,
			worktree: workspace?.worktree ?? null,
		},
		async () => {
		const startedAt = Date.now()
		const normalizedName = normalizeToolName(call.name)
		if (!normalizedName) {
			return {
				success: false,
				tool: call.name,
				error: `Unknown tool: ${call.name}`,
				executionMs: Date.now() - startedAt,
			}
		}
		if (normalizedName !== call.name) {
			call = { ...call, name: normalizedName }
		}

		try {
			if (call.name === 'web_search') {
				const input = toolSchemas.web_search.parse(call.arguments)
				const ctx = toolUserContext.getStore()
				const result = await webSearch(input.query)
				// Phase 2 ledger: log every web_search as 1 call. SEARCH_COST_PER_CALL_USD lets
				// operators set a per-call cost (e.g. for paid backends like Serper); SearXNG is
				// self-hosted so cost defaults to 0 but the call count is still tracked.
				const costPerCall = Number.parseFloat(env.SEARCH_COST_PER_CALL_USD ?? '0') || 0
				void logToolUsage({
					toolName: 'web_search',
					provider: env.SEARXNG_URL ? 'searxng' : null,
					unitType: 'call',
					units: 1,
					cost: costPerCall,
					userId: ctx?.userId ?? null,
					runId: ctx?.runId ?? null,
					metadata: { query: input.query.slice(0, 240), resultCount: result.length },
				}).catch((err) => console.warn('[tool-usage] web_search log failed', err))
				return {
					success: true,
					tool: call.name,
					input,
					result,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'shell') {
				const input = toolSchemas.shell.parse(call.arguments)
				const shellResult = await execShell(input.command)
				return {
					success: shellResult.success,
					tool: call.name,
					input,
					result: shellResult,
					error: shellResult.success ? undefined : shellResult.output,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'file_read') {
				const input = toolSchemas.file_read.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await readFile(input.path, input.startLine, input.endLine),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'file_write') {
				const input = toolSchemas.file_write.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await writeFile(input.path, input.content),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'file_patch') {
				const input = toolSchemas.file_patch.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await patchFile(input.patch),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'file_replace') {
				const input = toolSchemas.file_replace.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await replaceInFile(input.path, input.oldStr, input.newStr, {
						requireUnique: input.requireUnique,
						replaceAll: input.replaceAll,
					}),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'list_directory') {
				const input = toolSchemas.list_directory.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await listDirectory(input.path, input.depth, input.includeHidden),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'delete_file') {
				const input = toolSchemas.delete_file.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await deleteFile(input.path, input.recursive),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'move_file') {
				const input = toolSchemas.move_file.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await moveFile(input.fromPath, input.toPath, input.overwrite),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'search_files') {
				const input = toolSchemas.search_files.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await searchFiles(input.query, {
						path: input.path,
						maxResults: input.maxResults,
						isRegex: input.isRegex,
						includeIgnored: input.includeIgnored,
						caseSensitive: input.caseSensitive,
					}),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'file_info') {
				const input = toolSchemas.file_info.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await fileInfo(input.path),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'browser_screenshot') {
				const input = toolSchemas.browser_screenshot.parse(call.arguments)
				return {
					success: true,
					tool: call.name,
					input,
					result: await browserScreenshot(input.url),
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'web_fetch') {
				const input = toolSchemas.web_fetch.parse(call.arguments)
				const result = await webFetch(input.url, input.maxChars)
				return {
					success: true,
					tool: call.name,
					input,
					result,
					executionMs: Date.now() - startedAt,
				}
			}

			// Wave 4 #15 phase 2 finish — bind a project to the current conversation so
			// subsequent edits target it by default. Updates conversations.project_id.
			if (call.name === 'set_project_context') {
				const input = toolSchemas.set_project_context.parse(call.arguments)
				const ctxSnapshot = toolUserContext.getStore()
				const conversationId = await resolveConversationFromRunId(ctxSnapshot?.runId ?? null)
				if (!conversationId) {
					return {
						success: false,
						tool: call.name,
						error: 'no conversation context available for this tool call',
						executionMs: Date.now() - startedAt,
					}
				}
				if (input.projectId) {
					// Verify ownership before binding.
					const projectsModule = await import('$lib/projects/projects.server')
					const project = await projectsModule.getProjectById(input.projectId)
					if (!project || project.userId !== userId) {
						return {
							success: false,
							tool: call.name,
							error: `Project ${input.projectId} not found or not accessible`,
							executionMs: Date.now() - startedAt,
						}
					}
				}
				const { conversations: convoTable } = await import('$lib/sessions/sessions.schema')
				const { eq } = await import('drizzle-orm')
				await db
					.update(convoTable)
					.set({ projectId: input.projectId ?? null, updatedAt: new Date() })
					.where(eq(convoTable.id, conversationId))
				return {
					success: true,
					tool: call.name,
					input,
					result: {
						conversationId,
						projectId: input.projectId ?? null,
						bound: input.projectId !== null && input.projectId !== undefined,
					},
					executionMs: Date.now() - startedAt,
				}
			}

			// Wave 4 #15 phase 2 — Projects + Artifacts agent tools.
			if (
				call.name === 'list_projects' ||
				call.name === 'create_project' ||
				call.name === 'list_artifacts' ||
				call.name === 'read_artifact' ||
				call.name === 'create_artifact' ||
				call.name === 'edit_artifact'
			) {
				const projectsModule = await import('$lib/projects/projects.server')
				if (call.name === 'list_projects') {
					toolSchemas.list_projects.parse(call.arguments)
					const rows = await projectsModule.listProjects(userId)
					return {
						success: true,
						tool: call.name,
						input: {},
						result: rows.map((r) => ({
							id: r.id,
							name: r.name,
							slug: r.slug,
							kind: r.kind,
							description: r.description,
							updatedAt: r.updatedAt,
						})),
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'create_project') {
					const input = toolSchemas.create_project.parse(call.arguments)
					const created = await projectsModule.createProject({
						userId,
						name: input.name,
						kind: input.kind,
						description: input.description ?? null,
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: { id: created.id, name: created.name, slug: created.slug, kind: created.kind },
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'list_artifacts') {
					const input = toolSchemas.list_artifacts.parse(call.arguments)
					// Ownership check — only list artifacts in projects the user owns.
					const project = await projectsModule.getProjectById(input.projectId)
					if (!project || project.userId !== userId) {
						return {
							success: false,
							tool: call.name,
							error: `Project ${input.projectId} not found or not accessible`,
							executionMs: Date.now() - startedAt,
						}
					}
					const rows = await projectsModule.listArtifactsForProject(input.projectId, {
						includeInactive: input.includeInactive,
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: rows.map((a) => ({
							id: a.id,
							name: a.name,
							slug: a.slug,
							contentType: a.contentType,
							isActive: a.isActive,
							updatedAt: a.updatedAt,
						})),
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'read_artifact') {
					const input = toolSchemas.read_artifact.parse(call.arguments)
					const artifact = await projectsModule.getArtifactById(input.artifactId)
					if (!artifact) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} not found`,
							executionMs: Date.now() - startedAt,
						}
					}
					const project = await projectsModule.getProjectById(artifact.projectId)
					if (!project || project.userId !== userId) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} not accessible`,
							executionMs: Date.now() - startedAt,
						}
					}
					return {
						success: true,
						tool: call.name,
						input,
						result: {
							id: artifact.id,
							name: artifact.name,
							slug: artifact.slug,
							contentType: artifact.contentType,
							projectId: artifact.projectId,
							projectName: project.name,
							versionSeq: artifact.currentVersion ? 1 : 0, // currentVersion presence indicates loaded
							currentVersionId: artifact.currentVersionId,
							content: artifact.currentVersion?.content ?? '',
						},
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'create_artifact') {
					const input = toolSchemas.create_artifact.parse(call.arguments)
					const project = await projectsModule.getProjectById(input.projectId)
					if (!project || project.userId !== userId) {
						return {
							success: false,
							tool: call.name,
							error: `Project ${input.projectId} not found or not accessible`,
							executionMs: Date.now() - startedAt,
						}
					}
					const created = await projectsModule.createArtifact({
						projectId: input.projectId,
						name: input.name,
						content: input.content,
						contentType: input.contentType,
						changeNote: input.changeNote,
						editedBy: userId,
						sourceRunId: toolUserContext.getStore()?.runId ?? null,
					})
					return {
						success: true,
						tool: call.name,
						input: { ...input, content: `[${input.content.length} chars]` },
						result: {
							id: created.id,
							name: created.name,
							slug: created.slug,
							contentType: created.contentType,
							versionSeq: 1,
						},
						executionMs: Date.now() - startedAt,
					}
				}
				if (call.name === 'edit_artifact') {
					const input = toolSchemas.edit_artifact.parse(call.arguments)
					const artifact = await projectsModule.getArtifactById(input.artifactId)
					if (!artifact) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} not found`,
							executionMs: Date.now() - startedAt,
						}
					}
					const project = await projectsModule.getProjectById(artifact.projectId)
					if (!project || project.userId !== userId) {
						return {
							success: false,
							tool: call.name,
							error: `Artifact ${input.artifactId} not accessible`,
							executionMs: Date.now() - startedAt,
						}
					}
					const newVersion = await projectsModule.editArtifact({
						artifactId: input.artifactId,
						content: input.content,
						changeNote: input.changeNote,
						editedBy: userId,
						sourceRunId: toolUserContext.getStore()?.runId ?? null,
					})
					return {
						success: true,
						tool: call.name,
						input: { ...input, content: `[${input.content.length} chars]` },
						result: {
							versionId: newVersion?.id,
							seq: newVersion?.seq,
							artifactId: input.artifactId,
						},
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'image_generate') {
				const input = toolSchemas.image_generate.parse(call.arguments)
				const result = await generateImage(input.prompt, input.model, input.size)
				return {
					success: true,
					tool: call.name,
					input,
					result,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'update_agent') {
				const input = toolSchemas.update_agent.parse(call.arguments)
				const updated = await updateAgentRecord(input.agentId, {
					name: input.name,
					role: input.role,
					systemPrompt: input.systemPrompt,
					model: input.model,
				})
				if (!updated) {
					return {
						success: false,
						tool: call.name,
						error: 'Agent not found or no fields provided',
						executionMs: Date.now() - startedAt,
					}
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: updated.id, name: updated.name, status: updated.status },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'pause_agent') {
				const input = toolSchemas.pause_agent.parse(call.arguments)
				const updated = await setAgentStatus(input.agentId, 'paused')
				if (!updated) {
					return { success: false, tool: call.name, error: 'Agent not found', executionMs: Date.now() - startedAt }
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: updated.id, status: updated.status },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'resume_agent') {
				const input = toolSchemas.resume_agent.parse(call.arguments)
				const updated = await setAgentStatus(input.agentId, 'active')
				if (!updated) {
					return { success: false, tool: call.name, error: 'Agent not found', executionMs: Date.now() - startedAt }
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: updated.id, status: updated.status },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'create_user') {
				const input = toolSchemas.create_user.parse(call.arguments)
				requireAdminRequestUser()
				const username = normalizeUsername(input.username)
				const [created] = await db
					.insert(users)
					.values({
						username,
						name: input.name?.trim() || username,
						role: input.role,
						isActive: true,
					})
					.returning({ id: users.id, username: users.username, role: users.role })
				return {
					success: true,
					tool: call.name,
					input,
					result: created,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'create_automation') {
				const input = toolSchemas.create_automation.parse(call.arguments)
				const created = await createAutomationRecord({
					userId,
					agentId: input.agentId ?? null,
					description: input.description,
					cronExpression: input.cronExpression,
					prompt: input.prompt,
					enabled: input.enabled,
					conversationMode: input.conversationMode,
				})
				return {
					success: true,
					tool: call.name,
					input,
					result: created,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'list_automations') {
				const input = toolSchemas.list_automations.parse(call.arguments)
				const rows = await listAutomationsForUser(userId)
				return {
					success: true,
					tool: call.name,
					input,
					result: rows,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'update_automation') {
				const input = toolSchemas.update_automation.parse(call.arguments)
				const updated = await updateAutomationRecord(userId, input.automationId, {
					agentId: input.agentId,
					description: input.description,
					cronExpression: input.cronExpression,
					prompt: input.prompt,
					enabled: input.enabled,
					conversationMode: input.conversationMode,
				})
				if (!updated) {
					return { success: false, tool: call.name, error: 'Automation not found', executionMs: Date.now() - startedAt }
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: updated,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'delete_automation') {
				const input = toolSchemas.delete_automation.parse(call.arguments)
				await deleteAutomationRecord(userId, input.automationId)
				return {
					success: true,
					tool: call.name,
					input,
					result: { deleted: input.automationId },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'ask_user') {
				const input = toolSchemas.ask_user.parse(call.arguments)
				return {
					success: false,
					tool: call.name,
					input,
					error: 'ask_user must be handled by chat streaming flow and cannot run directly.',
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'list_skills') {
				const summaries = await listSkillSummaries()
				return {
					success: true,
					tool: call.name,
					input: {},
					result: summaries,
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'read_skill') {
				const input = toolSchemas.read_skill.parse(call.arguments)
				const skill = await getSkillByName(input.name)
				if (!skill) {
					return {
						success: false,
						tool: call.name,
						error: `Skill "${input.name}" not found`,
						executionMs: Date.now() - startedAt,
					}
				}
				await bumpSkillAccess(skill.id)
				return {
					success: true,
					tool: call.name,
					input,
					result: {
						name: skill.name,
						description: skill.description,
						content: skill.content,
						tags: skill.tags,
						files: skill.files.map((f) => ({ name: f.name, description: f.description })),
					},
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'read_skill_file') {
				const input = toolSchemas.read_skill_file.parse(call.arguments)
				const skill = await getSkillByName(input.skillName)
				if (!skill) {
					return {
						success: false,
						tool: call.name,
						error: `Skill "${input.skillName}" not found`,
						executionMs: Date.now() - startedAt,
					}
				}
				const file = await getSkillFileByName(skill.id, input.fileName)
				if (!file) {
					return {
						success: false,
						tool: call.name,
						error: `File "${input.fileName}" not found in skill "${input.skillName}"`,
						executionMs: Date.now() - startedAt,
					}
				}
				await bumpSkillAccess(skill.id)
				return {
					success: true,
					tool: call.name,
					input,
					result: { name: file.name, description: file.description, content: file.content },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'create_skill') {
				const input = toolSchemas.create_skill.parse(call.arguments)
				const skill = await createSkill(input.name, input.description, input.content, input.tags)
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: skill.id, name: skill.name },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'update_skill') {
				const input = toolSchemas.update_skill.parse(call.arguments)
				const skill = await getSkillByName(input.name)
				if (!skill) {
					return {
						success: false,
						tool: call.name,
						error: `Skill "${input.name}" not found`,
						executionMs: Date.now() - startedAt,
					}
				}
				const { name: _name, ...fields } = input
				const updated = await updateSkillRecord(skill.id, fields)
				return {
					success: true,
					tool: call.name,
					input,
					result: { id: updated.id, name: updated.name },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'add_skill_file') {
				const input = toolSchemas.add_skill_file.parse(call.arguments)
				const skill = await getSkillByName(input.skillName)
				if (!skill) {
					return {
						success: false,
						tool: call.name,
						error: `Skill "${input.skillName}" not found`,
						executionMs: Date.now() - startedAt,
					}
				}
				const file = await addSkillFile(skill.id, input.fileName, input.description, input.content)
				return {
					success: true,
					tool: call.name,
					input,
					result: { fileId: file.id, name: file.name },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'update_skill_file') {
				const input = toolSchemas.update_skill_file.parse(call.arguments)
				const skill = await getSkillByName(input.skillName)
				if (!skill) {
					return {
						success: false,
						tool: call.name,
						error: `Skill "${input.skillName}" not found`,
						executionMs: Date.now() - startedAt,
					}
				}
				const file = await getSkillFileByName(skill.id, input.fileName)
				if (!file) {
					return {
						success: false,
						tool: call.name,
						error: `File "${input.fileName}" not found in skill "${input.skillName}"`,
						executionMs: Date.now() - startedAt,
					}
				}
				const { skillName: _s, fileName: _f, ...fields } = input
				const updated = await updateSkillFileRecord(file.id, fields)
				return {
					success: true,
					tool: call.name,
					input,
					result: { fileId: updated.id, name: updated.name },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'delete_skill') {
				const input = toolSchemas.delete_skill.parse(call.arguments)
				const skill = await getSkillByName(input.name)
				if (!skill) {
					return {
						success: false,
						tool: call.name,
						error: `Skill "${input.name}" not found`,
						executionMs: Date.now() - startedAt,
					}
				}
				await deleteSkillRecord(skill.id)
				return {
					success: true,
					tool: call.name,
					input,
					result: { deleted: input.name },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'delete_skill_file') {
				const input = toolSchemas.delete_skill_file.parse(call.arguments)
				const skill = await getSkillByName(input.skillName)
				if (!skill) {
					return {
						success: false,
						tool: call.name,
						error: `Skill "${input.skillName}" not found`,
						executionMs: Date.now() - startedAt,
					}
				}
				const file = await getSkillFileByName(skill.id, input.fileName)
				if (!file) {
					return {
						success: false,
						tool: call.name,
						error: `File "${input.fileName}" not found in skill "${input.skillName}"`,
						executionMs: Date.now() - startedAt,
					}
				}
				await deleteSkillFileRecord(file.id)
				return {
					success: true,
					tool: call.name,
					input,
					result: { deleted: input.fileName, fromSkill: input.skillName },
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'enable_capability') {
				const input = toolSchemas.enable_capability.parse(call.arguments)
				const ctx = toolUserContext.getStore()
				if (!ctx?.runId) {
					return {
						success: false,
						tool: call.name,
						error: 'enable_capability requires a runId in the tool execution context.',
						executionMs: Date.now() - startedAt,
					}
				}
				const { enableGroupForRun } = await import('$lib/tools/capabilities.server')
				const enableResult = await enableGroupForRun(ctx.runId, input.group)
				// Wave 2 #9 Phase 1 — surface companion skill summaries inline with the
				// enable result so the model learns when/how to use the new tools without
				// us having to recompute context slots for every round.
				let companionSummaries: Array<{ name: string; description: string }> = []
				if (enableResult.added) {
					try {
						const { getCompanionSkillsForGroups } = await import('$lib/skills/skills.server')
						const skills = await getCompanionSkillsForGroups([input.group])
						companionSummaries = skills.map((s) => ({ name: s.name, description: s.description }))
					} catch (err) {
						console.warn('[enable_capability] companion skill lookup failed', err)
					}
				}
				return {
					success: true,
					tool: call.name,
					input,
					result: {
						added: enableResult.added,
						enabledGroups: enableResult.enabledGroups,
						addedTools: enableResult.addedTools,
						companionSkills: companionSummaries,
						note: enableResult.added
							? `Enabled '${input.group}'. ${enableResult.addedTools.length} new tools available next round: ${enableResult.addedTools.join(', ')}.${
									companionSummaries.length > 0
										? ` Use \`read_skill\` to load any of these companion skills for usage guidance: ${companionSummaries.map((s) => s.name).join(', ')}.`
										: ''
								}`
							: `'${input.group}' was already enabled.`,
					},
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'propose_plan') {
				const input = toolSchemas.propose_plan.parse(call.arguments)
				// The plan-approval flow runs through the standard tool approval pipeline (the
				// stream handler emits tool_pending, blocks on user decision, then calls executeTool
				// only on approve). By the time we get here, the user has already approved.
				//
				// Wave 2 #11 phase 2 — persist the approved plan as a durable parent task plus one
				// child task per step. The current chat_run is linked to the parent so future runs
				// can show "this run materialized task <X>" in the UI. Best-effort: a failure in
				// task persistence does NOT fail the tool call (the orchestrator can still execute
				// the plan); we just lose the task linkage and log a warning.
				const ctx = toolUserContext.getStore()
				let parentTaskId: string | null = null
				const childTaskIds: string[] = []
				if (ctx?.userId && ctx?.runId) {
					try {
						const { chatRuns } = await import('$lib/runs/runs.schema')
						const { createTask } = await import('$lib/tasks/tasks.server')
						const { eq } = await import('drizzle-orm')
						const { db } = await import('$lib/db.server')
						const [run] = await db
							.select({ conversationId: chatRuns.conversationId, agentId: chatRuns.agentId })
							.from(chatRuns)
							.where(eq(chatRuns.id, ctx.runId))
							.limit(1)

						const parent = await createTask({
							title: input.summary,
							spec: stringifyPlanForSpec(input),
							status: 'running',
							ownerAgentId: run?.agentId ?? null,
							rootConversationId: run?.conversationId ?? null,
							createdBy: ctx.userId,
							metadata: {
								source: 'propose_plan',
								originRunId: ctx.runId,
								totalEstimatedCostUsd: input.totalEstimatedCostUsd,
								totalEstimatedDurationMin: input.totalEstimatedDurationMin,
								risks: input.risks,
								rollback: input.rollback,
							},
						})
						parentTaskId = parent.id

						for (let i = 0; i < input.steps.length; i++) {
							const step = input.steps[i]
							const child = await createTask({
								title: step.title,
								spec: step.detail ?? step.title,
								status: 'pending',
								parentTaskId: parent.id,
								ownerAgentId: run?.agentId ?? null,
								rootConversationId: run?.conversationId ?? null,
								priority: i,
								createdBy: ctx.userId,
								metadata: {
									source: 'propose_plan',
									originRunId: ctx.runId,
									stepIndex: i,
									estimatedDurationMin: step.estimatedDurationMin,
									estimatedCostUsd: step.estimatedCostUsd,
									blastRadius: step.blastRadius,
									reversible: step.reversible,
								},
							})
							childTaskIds.push(child.id)
						}

						// Back-link the originating run to the parent task so the UI can show the
						// task badge / drill into the plan from the run trace.
						await db.update(chatRuns).set({ taskId: parent.id }).where(eq(chatRuns.id, ctx.runId))
					} catch (err) {
						console.warn('[propose_plan] task persistence failed; orchestrator will proceed without task linkage', err)
						parentTaskId = null
						childTaskIds.length = 0
					}
				}

				return {
					success: true,
					tool: call.name,
					input,
					result: {
						approved: true,
						summary: input.summary,
						stepCount: input.steps.length,
						parentTaskId,
						childTaskIds,
					},
					executionMs: Date.now() - startedAt,
				}
			}

			if (call.name === 'git_status' || call.name === 'git_log' || call.name === 'git_diff') {
				const ctx = toolUserContext.getStore()
				if (!ctx?.worktree) {
					return {
						success: false,
						tool: call.name,
						error: `${call.name} is only available in a git-worktree workspace (configure agent.config.workspace.mode='worktree' with a repoPath).`,
						executionMs: Date.now() - startedAt,
					}
				}
				await ensureWorkspaceDir()
				const workspace = getWorkspace()
				try {
					if (call.name === 'git_status') {
						const result = await execFileAsync('git', ['-C', workspace, 'status', '--porcelain=v1', '-b'], {
							maxBuffer: 4 * 1024 * 1024,
							timeout: 30_000,
						})
						return {
							success: true,
							tool: call.name,
							input: {},
							result: { stdout: result.stdout, stderr: result.stderr },
							executionMs: Date.now() - startedAt,
						}
					}
					if (call.name === 'git_log') {
						const input = toolSchemas.git_log.parse(call.arguments)
						const args = [
							'-C',
							workspace,
							'log',
							`--max-count=${input.max}`,
							'--pretty=format:%h%x09%an%x09%ad%x09%s',
							'--date=short',
						]
						if (input.paths?.length) {
							args.push('--')
							for (const p of input.paths) args.push(safePath(p))
						}
						const result = await execFileAsync('git', args, {
							maxBuffer: 4 * 1024 * 1024,
							timeout: 30_000,
						})
						return {
							success: true,
							tool: call.name,
							input,
							result: { stdout: result.stdout, stderr: result.stderr },
							executionMs: Date.now() - startedAt,
						}
					}
					// git_diff
					const input = toolSchemas.git_diff.parse(call.arguments)
					const args = ['-C', workspace, 'diff']
					if (input.staged) args.push('--cached')
					if (input.ref) args.push(input.ref)
					if (input.paths?.length) {
						args.push('--')
						for (const p of input.paths) args.push(safePath(p))
					}
					const result = await execFileAsync('git', args, {
						maxBuffer: 8 * 1024 * 1024,
						timeout: 60_000,
					})
					return {
						success: true,
						tool: call.name,
						input,
						result: { stdout: result.stdout, stderr: result.stderr },
						executionMs: Date.now() - startedAt,
					}
				} catch (err: unknown) {
					const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
					return {
						success: false,
						tool: call.name,
						error: e.stderr ?? e.message ?? `${call.name} failed`,
						executionMs: Date.now() - startedAt,
					}
				}
			}

			if (call.name === 'run_subagent') {
				const input = toolSchemas.run_subagent.parse(call.arguments)
				const { chat: llmChat } = await import('$lib/llm/chat.server')
				const subagentMessages = [
					{
						role: 'system' as const,
						content: 'You are a focused subagent. Complete the given task and return a clear, concise result.',
					},
					{
						role: 'user' as const,
						content: input.context ? `Context: ${input.context}\n\nTask: ${input.task}` : `Task: ${input.task}`,
					},
				]
				const response = await llmChat(subagentMessages, 'anthropic/claude-sonnet-4')
				return {
					success: true,
					tool: call.name,
					input,
					result: response.content,
					executionMs: Date.now() - startedAt,
				}
			}

			return {
				success: false,
				tool: call.name,
				error: `Tool is not implemented: ${call.name}`,
				executionMs: Date.now() - startedAt,
			}
		} catch (error) {
			return {
				success: false,
				tool: call.name,
				error: error instanceof Error ? error.message : 'Tool execution failed',
				executionMs: Date.now() - startedAt,
			}
		}
		},
	)
}

export type AskUserQuestion = z.infer<typeof toolSchemas.ask_user>['questions'][number]
export type AskUserAnswers = Record<string, string>
