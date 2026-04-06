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
import { searchMemories } from '$lib/memory/memory.server'
import { db } from '$lib/db.server'
import { artifacts, artifactVersions } from '$lib/artifacts/artifacts.schema'
import { eq, max } from 'drizzle-orm'
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

const MOCK_EXTERNALS = env.E2E_MOCK_EXTERNALS === '1'
const execFileAsync = promisify(execFile)

let browser: Browser | null = null
let page: Page | null = null

const toolUserContext = new AsyncLocalStorage<{ userId: string }>()

function sanitizeUserId(userId: string) {
	if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
		throw new Error('Invalid user context for sandbox workspace')
	}
	return userId
}

function getWorkspace() {
	const ctx = toolUserContext.getStore()
	if (!ctx?.userId) {
		throw new Error('Missing user context for tool execution')
	}
	const baseRoot = env.SANDBOX_WORKSPACE || '/workspace/users'
	return resolve(baseRoot, sanitizeUserId(ctx.userId))
}

function safePath(userPath: string): string {
	const workspace = getWorkspace()
	const resolved = resolve(workspace, userPath)
	const workspaceWithSep = workspace.endsWith(sep) ? workspace : `${workspace}${sep}`
	if (!(resolved === workspace || resolved.startsWith(workspaceWithSep))) {
		throw new Error(`Path escapes sandbox workspace: ${userPath}`)
	}
	return resolved
}

interface ShellOpts {
	cwd?: string
	timeout?: number
	env?: Record<string, string>
}

async function ensureWorkspaceDir() {
	await mkdir(getWorkspace(), { recursive: true })
}

async function shellExec(command: string, opts: ShellOpts = {}) {
	await ensureWorkspaceDir()
	const workspace = getWorkspace()
	const cwd = opts.cwd ? safePath(opts.cwd) : workspace
	const timeout = opts.timeout ?? 120_000

	try {
		const { stdout, stderr } = await execFileAsync('bash', ['-c', command], {
			cwd,
			timeout,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env, ...opts.env },
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
	if (MOCK_EXTERNALS) {
		return [
			{
				title: `Mock result for ${query}`,
				url: 'https://example.com/mock-result',
				snippet: 'Deterministic mock search result for E2E execution.',
				engine: 'mock',
				score: 1,
			},
		].slice(0, limit)
	}

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
	if (MOCK_EXTERNALS) {
		return {
			url: 'https://placehold.co/1024x1024/333/fff?text=MOCK+IMAGE',
			model: MODEL_MAP[model],
			size,
			prompt,
			cost: 0,
		}
	}

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
	if (MOCK_EXTERNALS) {
		return {
			success: true,
			command,
			status: 'completed',
			exitCode: 0,
			output: `MOCK_SHELL_OUTPUT: ${command}`,
			raw: { mocked: true },
		}
	}

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
	if (MOCK_EXTERNALS) {
		return {
			path,
			content: `MOCK_FILE_CONTENT for ${path}`,
		}
	}

	const content =
		startLine !== undefined || endLine !== undefined
			? await fileReadRange(path, { startLine, endLine })
			: await fileRead(path)
	return { path, content }
}

export async function writeFile(path: string, content: string) {
	if (MOCK_EXTERNALS) {
		return {
			success: true,
			path,
			message: `MOCK_FILE_WRITE (${content.length} chars)`,
		}
	}

	await fileWrite(path, content)
	return {
		success: true,
		path,
		message: `File written (${content.length} chars)`,
	}
}

export async function patchFile(patch: string) {
	if (MOCK_EXTERNALS) {
		return {
			success: true,
			message: 'MOCK_PATCH_APPLIED',
		}
	}

	return filePatch(patch)
}

export async function replaceInFile(
	path: string,
	oldStr: string,
	newStr: string,
	options?: { requireUnique?: boolean; replaceAll?: boolean },
) {
	if (MOCK_EXTERNALS) {
		return {
			path,
			replacedCount: 1,
			matchCount: 1,
			message: 'MOCK_STR_REPLACE',
		}
	}

	return fileStrReplace(path, oldStr, newStr, options)
}

export async function listDirectory(path?: string, depth = 1, includeHidden = false) {
	if (MOCK_EXTERNALS) {
		return [{ path: 'mock.txt', name: 'mock.txt', isDirectory: false, size: 10, modified: new Date().toISOString() }]
	}

	return fileList(path, { depth, includeHidden })
}

export async function deleteFile(path: string, recursive = false) {
	if (MOCK_EXTERNALS) {
		return { success: true, path, recursive, message: 'MOCK_DELETE' }
	}

	await fileDelete(path, recursive)
	return { success: true, path, recursive }
}

export async function moveFile(fromPath: string, toPath: string, overwrite = false) {
	if (MOCK_EXTERNALS) {
		return { success: true, fromPath, toPath, overwrite, message: 'MOCK_MOVE' }
	}

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
	if (MOCK_EXTERNALS) {
		return [{ path: 'mock.txt', line: 1, preview: `MOCK_SEARCH_RESULT for ${query}` }]
	}

	return fileSearch(query, options)
}

export async function fileInfo(path: string) {
	if (MOCK_EXTERNALS) {
		return {
			path,
			isDirectory: false,
			isFile: true,
			size: 123,
			modified: new Date().toISOString(),
			created: new Date().toISOString(),
			permissions: '644',
		}
	}

	return sandboxFileInfo(path)
}

export async function browserNavigate(url: string) {
	if (MOCK_EXTERNALS) {
		return {
			success: true,
			url,
		}
	}

	const result = await sandboxBrowserNavigate(url)
	return {
		success: true,
		url: result.url,
		title: result.title,
	}
}

export async function browserScreenshot(url?: string) {
	if (MOCK_EXTERNALS) {
		return {
			mimeType: 'image/png',
			imageBase64: '',
		}
	}

	if (url) {
		await sandboxBrowserNavigate(url)
	}
	const buffer = await sandboxBrowserScreenshot()
	return {
		mimeType: 'image/png',
		imageBase64: buffer.toString('base64'),
	}
}

export async function getSandboxStatus() {
	if (MOCK_EXTERNALS) {
		return {
			success: true,
			message: 'Sandbox reachable (mock)',
			stats: { mocked: true },
		}
	}

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
	memory_search: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }),
	create_task: z.object({ title: z.string().min(1), description: z.string().min(1) }),
	run_subagent: z.object({ task: z.string().min(1), context: z.string().optional() }),
	image_generate: z.object({
		prompt: z.string().min(1).max(2000),
		model: z.enum(['flux', 'sdxl', 'dall-e']).default('flux'),
		size: z.enum(['256x256', '512x512', '1024x1024']).default('1024x1024'),
	}),
	artifact_create: z.object({
		type: z.enum([
			'markdown',
			'code',
			'config',
			'image',
			'svg',
			'mermaid',
			'html',
			'svelte',
			'data_table',
			'chart',
			'audio',
			'video',
		]),
		title: z.string().min(1).max(200),
		content: z.string(),
		language: z.string().max(60).optional(),
		category: z.string().max(60).optional(),
	}),
	artifact_update: z.object({
		artifactId: z.string().uuid(),
		content: z.string(),
		title: z.string().min(1).max(200).optional(),
	}),
	artifact_storage_update: z.object({
		artifactId: z.string().uuid(),
		key: z.string().min(1).max(200),
		value: z.unknown(),
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
	memory_search: 'Search persistent memory for relevant information.',
	create_task: 'Create a new agent task.',
	run_subagent:
		'Run a general-purpose subagent to handle a task. The subagent is stateless and returns a result without persistence.',
	image_generate: 'Generate an image from a text prompt.',
	artifact_create:
		'Create a persistent artifact (document, code, config, diagram, etc.). Use for code snippets over 15 lines, full documents, configs, diagrams, data tables, HTML pages, and Svelte components.',
	artifact_update: 'Update the content of an existing artifact. Creates a new version automatically.',
	artifact_storage_update:
		"Update a key in an artifact's persistent storage. Used for reactive/living artifacts like trackers and dashboards.",
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
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema) as Record<string, unknown>
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

export async function executeTool(call: ToolCall, userId: string) {
	return toolUserContext.run({ userId }, async () => {
		const startedAt = Date.now()
		try {
		if (call.name === 'web_search') {
			const input = toolSchemas.web_search.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await webSearch(input.query),
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'shell') {
			const input = toolSchemas.shell.parse(call.arguments)
			return {
				success: true,
				tool: call.name,
				input,
				result: await execShell(input.command),
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

		if (call.name === 'memory_search') {
			const input = toolSchemas.memory_search.parse(call.arguments)
			const matches = await searchMemories(input.query, input.limit)
			return {
				success: true,
				tool: call.name,
				input,
				result: matches,
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'create_task') {
			const input = toolSchemas.create_task.parse(call.arguments)
			const { createTaskForAvailableAgent } = await import('$lib/agents/agents.server')
			const task = await createTaskForAvailableAgent(input.title, input.description)
			return {
				success: true,
				tool: call.name,
				input,
				result: task,
				executionMs: Date.now() - startedAt,
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

		if (call.name === 'artifact_create') {
			const input = toolSchemas.artifact_create.parse(call.arguments)
			const [artifact] = await db
				.insert(artifacts)
				.values({
					type: input.type,
					title: input.title,
					content: input.content,
					language: input.language ?? null,
					category: input.category ?? null,
					conversationId: (call as ToolCallWithContext).conversationId ?? null,
					messageId: (call as ToolCallWithContext).messageId ?? null,
				})
				.returning()

			await db.insert(artifactVersions).values({
				artifactId: artifact.id,
				version: 1,
				content: input.content,
				language: input.language ?? null,
				metadata: {},
			})

			return {
				success: true,
				tool: call.name,
				input,
				result: { artifactId: artifact.id, title: artifact.title, type: artifact.type },
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'artifact_update') {
			const input = toolSchemas.artifact_update.parse(call.arguments)

			const [existing] = await db.select().from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1)
			if (!existing) {
				return { success: false, tool: call.name, error: 'Artifact not found', executionMs: Date.now() - startedAt }
			}

			const updates: Record<string, unknown> = { content: input.content, updatedAt: new Date() }
			if (input.title) updates.title = input.title

			await db.update(artifacts).set(updates).where(eq(artifacts.id, input.artifactId))

			// Auto-version
			const [maxRow] = await db
				.select({ maxVersion: max(artifactVersions.version) })
				.from(artifactVersions)
				.where(eq(artifactVersions.artifactId, input.artifactId))

			const nextVersion = (maxRow?.maxVersion ?? 0) + 1
			await db.insert(artifactVersions).values({
				artifactId: input.artifactId,
				version: nextVersion,
				content: input.content,
				language: existing.language,
				metadata: {},
			})

			return {
				success: true,
				tool: call.name,
				input,
				result: { artifactId: input.artifactId, version: nextVersion },
				executionMs: Date.now() - startedAt,
			}
		}

		if (call.name === 'artifact_storage_update') {
			const input = toolSchemas.artifact_storage_update.parse(call.arguments)

			const [existing] = await db
				.select({ storage: artifacts.storage })
				.from(artifacts)
				.where(eq(artifacts.id, input.artifactId))
				.limit(1)

			if (!existing) {
				return { success: false, tool: call.name, error: 'Artifact not found', executionMs: Date.now() - startedAt }
			}

			const newStorage = { ...existing.storage, [input.key]: input.value }
			await db
				.update(artifacts)
				.set({ storage: newStorage, updatedAt: new Date() })
				.where(eq(artifacts.id, input.artifactId))

			return {
				success: true,
				tool: call.name,
				input,
				result: { artifactId: input.artifactId, updatedKey: input.key },
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

		const input = toolSchemas.run_subagent.parse(call.arguments)
		const { runSubagent } = await import('$lib/agents/agents.server')
		const result = await runSubagent(input.task, input.context)
		return {
			success: true,
			tool: call.name,
			input,
			result,
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
	})
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

type PendingApproval = {
	resolve: (approved: boolean) => void
	timer: ReturnType<typeof setTimeout>
}

const pendingApprovals = new Map<string, PendingApproval>()

export function requestApproval(token: string): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (pendingApprovals.has(token)) {
				pendingApprovals.delete(token)
				resolve(false)
			}
		}, APPROVAL_TIMEOUT_MS)

		pendingApprovals.set(token, { resolve, timer })
	})
}

export function resolveApproval(token: string, approved: boolean): boolean {
	const entry = pendingApprovals.get(token)
	if (!entry) return false
	clearTimeout(entry.timer)
	pendingApprovals.delete(token)
	entry.resolve(approved)
	return true
}
