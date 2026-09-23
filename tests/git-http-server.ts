import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A throwaway git remote over plain HTTP, for specs that need to watch what server-side git
 * sends — which URL, with which `Authorization` header — and to push and fetch for real.
 *
 * Server-side git only speaks https (and http for a plain-http clone URL); `file://` is
 * refused on purpose, so a local bare repository is not reachable any other way. This
 * serves `git http-backend` as CGI from a temp directory, and records every request.
 *
 * Test infrastructure only. The git run here is the test's own, unhardened, on a directory
 * the test created.
 */

export type RecordedRequest = { method: string; url: string; authorization: string | null }

export type GitHttpServer = {
	/** `http://127.0.0.1:<port>` */
	origin: string
	root: string
	requests: RecordedRequest[]
	/** When set, any request without exactly this Authorization header gets a 401. */
	requireAuthorization: string | null
	close(): Promise<void>
}

const plainGitEnv = () => ({
	...process.env,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
	GIT_TERMINAL_PROMPT: '0',
})

/** Plain git for test setup, isolated from the developer's own config. */
export function git(args: string[], cwd?: string): string {
	const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: plainGitEnv() })
	if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
	return res.stdout.trim()
}

/**
 * Plain git, asynchronously, and without throwing — for control runs that talk to this
 * process's own HTTP server (a synchronous call would block the server it is waiting on)
 * and are expected to fail once the trap has fired.
 */
export function gitAsync(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn('git', args, { cwd, env: plainGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
		child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` }))
		child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
	})
}

export function makeTempDir(label: string): { path: string; cleanup: () => void } {
	const path = mkdtempSync(join(tmpdir(), `agentstudio-${label}-`))
	return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** A bare repository under the server root, seeded with one commit on `main`. */
export function createUpstream(root: string, name = 'upstream.git'): string {
	const bare = join(root, name)
	git(['init', '--bare', '-b', 'main', bare])
	git(['config', 'http.receivepack', 'true'], bare)
	const seed = join(root, `${name}-seed`)
	git(['init', '-b', 'main', seed])
	writeFileSync(join(seed, 'README.md'), '# upstream\n')
	git(['add', '-A'], seed)
	git(['commit', '-m', 'initial'], seed)
	git(['push', bare, 'main'], seed)
	return bare
}

/** Commit a file straight onto a branch of the bare upstream, as someone else pushing would. */
export function commitUpstream(root: string, bare: string, branch: string, file: string, content: string): string {
	const work = mkdtempSync(join(root, 'other-'))
	git(['clone', '-q', '-b', branch, bare, work])
	writeFileSync(join(work, file), content)
	git(['add', '-A'], work)
	git(['commit', '-m', `upstream: ${file}`], work)
	git(['push', 'origin', branch], work)
	return git(['rev-parse', 'HEAD'], work)
}

function runBackend(req: IncomingMessage, root: string, res: import('node:http').ServerResponse) {
	const url = new URL(req.url ?? '/', 'http://localhost')
	const child = spawn('git', ['http-backend'], {
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_PROJECT_ROOT: root,
			GIT_HTTP_EXPORT_ALL: '1',
			REMOTE_USER: 'test',
			REMOTE_ADDR: '127.0.0.1',
			REQUEST_METHOD: req.method ?? 'GET',
			PATH_INFO: decodeURIComponent(url.pathname),
			QUERY_STRING: url.search.replace(/^\?/, ''),
			CONTENT_TYPE: req.headers['content-type'] ?? '',
			HTTP_CONTENT_ENCODING: (req.headers['content-encoding'] as string | undefined) ?? '',
			GIT_PROTOCOL: (req.headers['git-protocol'] as string | undefined) ?? '',
		},
		stdio: ['pipe', 'pipe', 'ignore'],
	})
	req.pipe(child.stdin)
	let head = Buffer.alloc(0)
	let headersSent = false
	child.stdout.on('data', (chunk: Buffer) => {
		if (headersSent) {
			res.write(chunk)
			return
		}
		head = Buffer.concat([head, chunk])
		let end = head.indexOf('\r\n\r\n')
		let sep = 4
		if (end === -1) {
			end = head.indexOf('\n\n')
			sep = 2
		}
		if (end === -1) return
		let status = 200
		const headers: Record<string, string> = {}
		for (const line of head.subarray(0, end).toString('utf8').split(/\r?\n/)) {
			const colon = line.indexOf(':')
			if (colon === -1) continue
			const key = line.slice(0, colon).trim()
			const value = line.slice(colon + 1).trim()
			if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200
			else headers[key] = value
		}
		res.writeHead(status, headers)
		headersSent = true
		res.write(head.subarray(end + sep))
	})
	child.stdout.on('end', () => res.end())
	child.on('error', () => {
		if (!headersSent) res.writeHead(500)
		res.end()
	})
}

export async function startGitHttpServer(root: string): Promise<GitHttpServer> {
	const state: GitHttpServer = {
		origin: '',
		root,
		requests: [],
		requireAuthorization: null,
		close: async () => undefined,
	}
	const server: Server = createServer((req, res) => {
		const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
		state.requests.push({ method: req.method ?? 'GET', url: req.url ?? '', authorization })
		if (state.requireAuthorization && authorization !== state.requireAuthorization) {
			res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
			res.end()
			return
		}
		runBackend(req, root, res)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	state.origin = `http://127.0.0.1:${port}`
	state.close = () => new Promise((resolve) => server.close(() => resolve()))
	return state
}

/** A plain HTTP listener that records requests and answers 502 — stands in for a proxy. */
export async function startRecordingSink(): Promise<{ origin: string; hits: RecordedRequest[]; close(): Promise<void> }> {
	const hits: RecordedRequest[] = []
	const server = createServer((req, res) => {
		hits.push({
			method: req.method ?? 'GET',
			url: req.url ?? '',
			authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
		})
		res.writeHead(502)
		res.end()
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return {
		origin: `http://127.0.0.1:${port}`,
		hits,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	}
}
