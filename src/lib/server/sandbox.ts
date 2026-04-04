import { env } from '$env/dynamic/private'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve, join } from 'node:path'
import { readFile as fsRead, writeFile as fsWrite, unlink, readdir, stat, mkdir } from 'node:fs/promises'
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
	if (!resolved.startsWith(workspace)) {
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

export async function fileWrite(path: string, content: string) {
	const fullPath = safePath(path)
	await mkdir(resolve(fullPath, '..'), { recursive: true })
	await fsWrite(fullPath, content, 'utf-8')
}

export async function fileDelete(path: string) {
	const fullPath = safePath(path)
	await unlink(fullPath)
}

export async function fileList(path?: string) {
	const fullPath = path ? safePath(path) : getWorkspace()
	const entries = await readdir(fullPath)
	const results = await Promise.all(
		entries.map(async (name) => {
			const s = await stat(join(fullPath, name))
			return { name, isDirectory: s.isDirectory(), size: s.size, modified: s.mtime.toISOString() }
		}),
	)
	return results
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

// ---------------------------------------------------------------------------
// Code execution (pipes code to interpreter via shell)
// ---------------------------------------------------------------------------

export async function execCode(code: string, language: string) {
	const langMap: Record<string, string> = {
		typescript: 'bun eval',
		javascript: 'bun eval',
		ts: 'bun eval',
		js: 'bun eval',
		python: 'python3 -c',
		python3: 'python3 -c',
		py: 'python3 -c',
		bash: 'bash -c',
		sh: 'sh -c',
	}

	const interpreter = langMap[language.toLowerCase()]
	if (!interpreter) {
		return { exitCode: 1, stdout: '', stderr: `Unsupported language: ${language}` }
	}

	// Write code to a temp file to avoid shell escaping issues
	const tmpFile = `/tmp/sandbox_exec_${Date.now()}`
	await shellExec(`cat > ${tmpFile} << 'SANDBOX_EOF'\n${code}\nSANDBOX_EOF`)

	try {
		const [bin, ...args] = interpreter.split(' ')
		const result = await shellExec(`${bin} ${args.join(' ')} "$(cat ${tmpFile})"`, { timeout: 60_000 })
		return result
	} finally {
		await shellExec(`rm -f ${tmpFile}`).catch(() => {})
	}
}
