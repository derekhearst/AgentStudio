import { env } from '$env/dynamic/private'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join, dirname, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
	readFile as fsRead,
	writeFile as fsWrite,
	rm,
	readdir,
	stat,
	mkdir,
	rename as fsRename,
	access,
} from 'node:fs/promises'
import type { Browser, Page } from 'playwright'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Workspace path safety
// ---------------------------------------------------------------------------

function getWorkspace() {
	return env.SANDBOX_WORKSPACE || '/workspace'
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

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export interface ShellOpts {
	cwd?: string
	timeout?: number
	env?: Record<string, string>
}

export async function shellExec(command: string, opts: ShellOpts = {}) {
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

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function fileRead(path: string) {
	const fullPath = safePath(path)
	return fsRead(fullPath, 'utf-8')
}

export interface FileReadOpts {
	startLine?: number
	endLine?: number
}

export async function fileReadRange(path: string, opts: FileReadOpts = {}) {
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
	const fullPath = safePath(path)
	await mkdir(resolve(fullPath, '..'), { recursive: true })
	await fsWrite(fullPath, content, 'utf-8')
}

export async function fileDelete(path: string, recursive = false) {
	const fullPath = safePath(path)
	const info = await stat(fullPath)
	if (info.isDirectory() && !recursive) {
		throw new Error('Path is a directory. Set recursive=true to delete directories.')
	}
	await rm(fullPath, { recursive, force: true })
}

export async function fileMove(fromPath: string, toPath: string, overwrite = false) {
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
			// Target does not exist, proceed.
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

export async function fileInfo(path: string) {
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

// ---------------------------------------------------------------------------
// Git (convenience wrappers over shellExec)
// ---------------------------------------------------------------------------

export async function gitClone(repoUrl: string, dir?: string) {
	const target =
		dir ??
		repoUrl
			.split('/')
			.pop()
			?.replace(/\.git$/, '') ??
		'repo'
	const result = await shellExec(`git clone ${repoUrl} ${target}`)
	return { ...result, directory: target }
}

export async function gitStatus(repoDir: string) {
	return shellExec('git status --porcelain', { cwd: repoDir })
}

export async function gitCommit(repoDir: string, message: string) {
	await shellExec('git add -A', { cwd: repoDir })
	return shellExec(`git commit -m ${JSON.stringify(message)}`, { cwd: repoDir })
}

export async function gitPush(repoDir: string, remote = 'origin', branch = 'main') {
	return shellExec(`git push ${remote} ${branch}`, { cwd: repoDir })
}

export async function gitDiff(repoDir: string) {
	return shellExec('git diff', { cwd: repoDir })
}

// ---------------------------------------------------------------------------
// Browser (Playwright — lazy-launched headless Chromium)
// ---------------------------------------------------------------------------

let browser: Browser | null = null
let page: Page | null = null

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

export async function browserNavigate(url: string) {
	const p = await getPage()
	await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
	return { title: await p.title(), url: p.url() }
}

export async function browserScreenshot(): Promise<Buffer> {
	const p = await getPage()
	return (await p.screenshot({ type: 'png', fullPage: false })) as Buffer
}

export async function browserClick(selector: string) {
	const p = await getPage()
	await p.click(selector, { timeout: 10_000 })
}

export async function browserType(selector: string, text: string) {
	const p = await getPage()
	await p.fill(selector, text, { timeout: 10_000 })
}

export async function browserGetText(selector?: string) {
	const p = await getPage()
	if (selector) {
		return p.textContent(selector, { timeout: 10_000 })
	}
	return p.evaluate(() => document.body.innerText)
}

export async function browserGetHtml(selector?: string) {
	const p = await getPage()
	if (selector) {
		return p.innerHTML(selector, { timeout: 10_000 })
	}
	return p.evaluate(() => document.documentElement.outerHTML)
}

export async function browserEvaluate(script: string) {
	const p = await getPage()
	return p.evaluate(script)
}

export async function browserClose() {
	if (page && !page.isClosed()) {
		await page.close().catch(() => {})
		page = null
	}
	if (browser && browser.isConnected()) {
		await browser.close().catch(() => {})
		browser = null
	}
}
