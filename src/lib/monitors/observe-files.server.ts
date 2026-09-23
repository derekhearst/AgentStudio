import type { Dirent } from 'node:fs'
import { glob, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { resolveWorkspaceRoot, safePathWithin } from '$lib/workspace/workspace.server'
import {
	monitorFileToolArgsSchemas,
	MONITOR_FILE_MAX_BYTES,
	MONITOR_FILE_MAX_RESULTS,
	type MonitorFileTool,
} from './condition'

/**
 * #33 — how a monitor looks at files.
 *
 * `Read`, `Grep` and `Glob` are the Agent SDK's built-ins: the engine hands them to the model
 * itself, so the in-house executor that runs a monitor's other tools has no handler for them,
 * and every check of a file monitor used to fail with "Unknown tool". A monitor runs them
 * here instead, with the same argument names an agent uses.
 *
 * The rules:
 *   - read-only — nothing here writes, and there is no shell;
 *   - the view is the owner's whole sandbox (`<sandbox>/<userId>`, the same boundary the
 *     preview pane uses), so a path like `projects/<id>/build.log` reaches a project's files;
 *   - a path argument is contained twice: lexically (`safePathWithin`), then by its real path;
 *   - symbolic links are not followed: `Glob` and `Grep` neither descend into nor list one, and
 *     drop anything whose directory resolves outside the sandbox, so a link inside the sandbox
 *     cannot lead a monitor outside it (`fs.glob` on its own follows them);
 *   - results are bounded (`MONITOR_FILE_MAX_BYTES` per file, `MONITOR_FILE_MAX_RESULTS`
 *     entries) and sorted, so an unchanged tree observes the same value on every check and
 *     `changed` means something changed;
 *   - so is the work: a walk looks at a bounded number of entries, and `Grep` — whose pattern
 *     the model may have written — matches on a worker thread, with a time limit and a cap on
 *     what it reads, so a pathological pattern or a huge tree fails the check instead of
 *     freezing the server that runs it.
 */

/** Directories never worth descending into; dot-directories are skipped by `**` already. */
const SKIPPED_DIRECTORIES = new Set(['node_modules'])
/** Most files a `Grep` looks inside before giving up on the rest. */
const GREP_MAX_FILES = 5_000
/** Most paths a `Glob` gathers before sorting and cutting to `MONITOR_FILE_MAX_RESULTS`. */
const GLOB_MAX_SCAN = 20_000
/** Most directory entries one walk looks at, matching or not. */
const WALK_MAX_VISITS = 100_000
/** The SDK's default `head_limit`. */
const GREP_DEFAULT_LIMIT = 250
/** A line longer than this is matched on its first this-many characters. */
const GREP_MAX_LINE_CHARS = 10_000

/** Limits a check runs under; the defaults are production's, and specs lower them. */
export type MonitorFileLimits = {
	/** How long one `Grep` may take, reading included, before the check fails. */
	grepTimeoutMs: number
	/** How much one `Grep` may read across every file it looks in. */
	grepMaxTotalBytes: number
}

const DEFAULT_LIMITS: MonitorFileLimits = {
	grepTimeoutMs: 10_000,
	grepMaxTotalBytes: 50 * 1024 * 1024,
}

/** The monitor's filesystem: its owner's sandbox root, as the tool executor resolves it. */
export function monitorSandboxRoot(userId: string): string {
	return resolveWorkspaceRoot({ userId, sandboxRoot: process.env.SANDBOX_WORKSPACE })
}

/**
 * Run one file observation. `root` is the sandbox to observe (`monitorSandboxRoot` in
 * production, a temp directory in specs). Throws on anything that is not an observation —
 * a missing file, a path outside the sandbox, a bad pattern, a search that ran too long — so
 * the caller records a failed check rather than an empty value.
 */
export async function observeFileTool(
	root: string,
	tool: MonitorFileTool,
	args: Record<string, unknown>,
	limits: Partial<MonitorFileLimits> = {},
): Promise<unknown> {
	switch (tool) {
		case 'Read':
			return readFileForMonitor(root, monitorFileToolArgsSchemas.Read.parse(args))
		case 'Grep':
			return grepForMonitor(root, monitorFileToolArgsSchemas.Grep.parse(args), { ...DEFAULT_LIMITS, ...limits })
		case 'Glob':
			return globForMonitor(root, monitorFileToolArgsSchemas.Glob.parse(args))
		default: {
			const exhaustive: never = tool
			throw new Error(`not a monitor file tool: ${String(exhaustive)}`)
		}
	}
}

// ─────────── Read ───────────

/** The file's text — or the requested lines of it — as a bare string, so `contains` reads it directly. */
async function readFileForMonitor(
	root: string,
	args: { file_path: string; offset?: number; limit?: number },
): Promise<string> {
	const { target } = await containedPath(root, args.file_path)
	const info = await stat(target)
	if (!info.isFile()) throw new Error(`${args.file_path} is not a file`)
	if (info.size > MONITOR_FILE_MAX_BYTES) {
		throw new Error(`${args.file_path} is ${info.size} bytes; a monitor reads files up to ${MONITOR_FILE_MAX_BYTES} bytes`)
	}
	const content = await readFile(target, 'utf-8')
	if (args.offset === undefined && args.limit === undefined) return content
	const start = (args.offset ?? 1) - 1
	const lines = content.split(/\r?\n/)
	return lines.slice(start, args.limit === undefined ? undefined : start + args.limit).join('\n')
}

// ─────────── Glob ───────────

/** Matching paths, relative to the sandbox, sorted. */
async function globForMonitor(root: string, args: { pattern: string; path?: string }): Promise<string[]> {
	assertRelativePattern(args.pattern)
	const { realRoot, target } = args.path ? await containedPath(root, args.path) : await sandboxRoot(root)
	const found = await globInside(target, args.pattern, realRoot, { maxResults: GLOB_MAX_SCAN })
	return found
		.map((entry) => toSandboxPath(realRoot, entry.path))
		.sort()
		.slice(0, MONITOR_FILE_MAX_RESULTS)
}

/**
 * `fs.glob` under `dir`, kept inside the sandbox. `fs.glob` follows symbolic links to
 * directories, so a link in the sandbox pointing at `/` would let `**` list the whole disk:
 *   - `exclude` stops the walk descending into a link, or into `node_modules`;
 *   - a result that is itself a link is dropped, as ripgrep leaves them out by default;
 *   - a result whose directory resolves outside `realRoot` is dropped. That is what a link
 *     the pattern names literally leads to (`link/*`): the walk goes straight through such a
 *     segment without asking `exclude`.
 * The walk also stops after `WALK_MAX_VISITS` entries looked at, matching or not, so a pattern
 * that sends it somewhere huge costs a bounded amount of work.
 */
async function globInside(
	dir: string,
	pattern: string,
	realRoot: string,
	opts: { maxResults: number; filesOnly?: boolean },
): Promise<Array<{ path: string; isFile: boolean }>> {
	let visits = 0
	const exclude = (entry: Dirent) => {
		visits += 1
		return visits > WALK_MAX_VISITS || entry.isSymbolicLink() || SKIPPED_DIRECTORIES.has(entry.name)
	}
	const directoryInside = new Map<string, boolean>()
	const found: Array<{ path: string; isFile: boolean }> = []
	for await (const entry of glob(pattern, { cwd: dir, withFileTypes: true, exclude })) {
		visits += 1
		if (visits > WALK_MAX_VISITS) break
		if (entry.isSymbolicLink()) continue
		if (opts.filesOnly && !entry.isFile()) continue
		const parent = resolve(dir, entry.parentPath)
		let inside = directoryInside.get(parent)
		if (inside === undefined) {
			inside = await realpath(parent).then(
				(real) => isWithin(realRoot, real),
				() => false,
			)
			directoryInside.set(parent, inside)
		}
		if (!inside) continue
		found.push({ path: resolve(parent, entry.name), isFile: entry.isFile() })
		if (found.length >= opts.maxResults) break
	}
	return found
}

// ─────────── Grep ───────────

type GrepMode = 'files_with_matches' | 'content' | 'count'

type GrepArgs = {
	pattern: string
	path?: string
	glob?: string
	output_mode?: GrepMode
	'-i'?: boolean
	head_limit?: number
}

/**
 * Line-by-line regex search, in the SDK's three output shapes: matching paths (the default),
 * `{ path, line, text }` per matching line, or `{ path, count }` per file. Binary files and
 * files over the size cap are skipped, not failed.
 *
 * The pattern is a JavaScript regular expression, and those backtrack: `(a+)+$` against a run
 * of `a`s takes exponential time, and plenty of innocent patterns take quadratic time on a long
 * minified line. The agent's own Grep uses ripgrep, which cannot do either; this runs inside the
 * web server. So the matching happens on a worker thread, the whole search — reading included —
 * has `grepTimeoutMs` before the check fails, it reads at most `grepMaxTotalBytes`, and a line
 * is matched on its first `GREP_MAX_LINE_CHARS` characters.
 */
async function grepForMonitor(root: string, args: GrepArgs, limits: MonitorFileLimits): Promise<unknown[]> {
	const flags = args['-i'] ? 'i' : ''
	try {
		new RegExp(args.pattern, flags)
	} catch {
		throw new Error(`Grep pattern is not a valid regular expression: ${args.pattern}`)
	}
	const { realRoot, target } = args.path ? await containedPath(root, args.path) : await sandboxRoot(root)
	// As in the SDK: 250 by default, 0 for "no limit" (which here is the cap).
	const limit =
		args.head_limit === undefined ? GREP_DEFAULT_LIMIT : args.head_limit === 0 ? MONITOR_FILE_MAX_RESULTS : args.head_limit
	const mode = args.output_mode ?? 'files_with_matches'

	const matcher = startLineMatcher(args.pattern, flags, limits.grepTimeoutMs)
	try {
		const files = (await stat(target)).isFile() ? [target] : await filesUnder(target, realRoot, args.glob)
		const out: unknown[] = []
		let bytesRead = 0
		for (const file of files) {
			matcher.assertRunning()
			const read = await readTextIfSmall(file, realRoot)
			if (read === null) continue
			bytesRead += read.bytes
			if (bytesRead > limits.grepMaxTotalBytes) {
				throw new Error(
					`Grep would read more than ${formatBytes(limits.grepMaxTotalBytes)}; narrow it with "path" or "glob"`,
				)
			}
			const path = toSandboxPath(realRoot, file)
			const result = await matcher.match(read.text, mode, limit - out.length)
			if (mode === 'files_with_matches') {
				if (result === true) out.push(path)
			} else if (mode === 'count') {
				if (typeof result === 'number' && result > 0) out.push({ path, count: result })
			} else if (Array.isArray(result)) {
				for (const hit of result as Array<{ line: number; text: string }>) out.push({ path, ...hit })
			}
			if (out.length >= limit) break
		}
		return out.slice(0, limit)
	} finally {
		matcher.close()
	}
}

/** Files under `dir` whose name matches `nameGlob` (every file when omitted), sorted. */
async function filesUnder(dir: string, realRoot: string, nameGlob?: string): Promise<string[]> {
	// Like `rg --glob`: a bare `*.log` matches at any depth; a pattern with a slash is a path.
	const pattern = nameGlob ? (nameGlob.includes('/') ? nameGlob : `**/${nameGlob}`) : '**/*'
	assertRelativePattern(pattern)
	const files = await globInside(dir, pattern, realRoot, { maxResults: GREP_MAX_FILES, filesOnly: true })
	return files.map((entry) => entry.path).sort()
}

/** A regular file's text, or null when it is not one, is too large, is binary, or leads outside. */
async function readTextIfSmall(file: string, realRoot: string): Promise<{ text: string; bytes: number } | null> {
	try {
		const real = await realpath(file)
		if (!isWithin(realRoot, real)) return null
		const info = await stat(real)
		if (!info.isFile() || info.size > MONITOR_FILE_MAX_BYTES) return null
		const text = await readFile(real, 'utf-8')
		return text.includes('\u0000') ? null : { text, bytes: info.size }
	} catch {
		// Deleted between listing and reading, or unreadable: not part of this observation.
		return null
	}
}

/**
 * The worker's source. Plain CommonJS evaluated from a string (`eval: true`), so it needs no
 * file of its own for the bundler to find. It compiles the pattern once, then answers one
 * message per file: whether any line matches, how many do, or which ones (up to `remaining`).
 * No `g` flag, so `test` keeps no state between lines.
 */
const LINE_MATCHER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const re = new RegExp(workerData.pattern, workerData.flags)
const cap = (line) => (line.length > workerData.maxLineChars ? line.slice(0, workerData.maxLineChars) : line)
parentPort.on('message', ({ text, mode, remaining }) => {
	const lines = text.split(/\\r?\\n/)
	if (mode === 'files_with_matches') {
		parentPort.postMessage(lines.some((line) => re.test(cap(line))))
	} else if (mode === 'count') {
		let count = 0
		for (const line of lines) if (re.test(cap(line))) count += 1
		parentPort.postMessage(count)
	} else {
		const hits = []
		for (let i = 0; i < lines.length && hits.length < remaining; i += 1) {
			if (re.test(cap(lines[i]))) hits.push({ line: i + 1, text: lines[i].slice(0, 300) })
		}
		parentPort.postMessage(hits)
	}
})
`

type LineMatcher = {
	/** The worker's answer for one file's text; rejects once the search has failed or timed out. */
	match(text: string, mode: GrepMode, remaining: number): Promise<unknown>
	/** Throws once the search has failed or run out of time, so reading the next file stops too. */
	assertRunning(): void
	/** Stop the worker. Always called, in a `finally`. */
	close(): void
}

/**
 * A worker thread that matches lines for one `Grep`. The timer covers the whole search: when
 * it fires, the worker is terminated — which interrupts a regex that is still backtracking —
 * and the file being matched, and every later one, rejects with a message that says why.
 */
function startLineMatcher(pattern: string, flags: string, timeoutMs: number): LineMatcher {
	const worker = new Worker(LINE_MATCHER_SOURCE, {
		eval: true,
		workerData: { pattern, flags, maxLineChars: GREP_MAX_LINE_CHARS },
	})
	let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null
	let failure: Error | null = null
	const fail = (error: Error) => {
		failure ??= error
		pending?.reject(failure)
		pending = null
		void worker.terminate()
	}
	const timer = setTimeout(
		() => fail(new Error(`Grep took longer than ${formatDuration(timeoutMs)}; narrow the pattern, "path" or "glob"`)),
		timeoutMs,
	)
	worker.on('message', (value: unknown) => {
		pending?.resolve(value)
		pending = null
	})
	worker.on('error', (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
	worker.on('exit', (code: number) => {
		if (pending) fail(new Error(`Grep stopped unexpectedly (exit code ${code})`))
	})
	return {
		match(text, mode, remaining) {
			if (failure) return Promise.reject(failure)
			return new Promise((resolve, reject) => {
				pending = { resolve, reject }
				worker.postMessage({ text, mode, remaining })
			})
		},
		assertRunning() {
			if (failure) throw failure
		},
		close() {
			clearTimeout(timer)
			failure ??= new Error('Grep finished')
			void worker.terminate()
		},
	}
}

function formatDuration(ms: number): string {
	return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

function formatBytes(bytes: number): string {
	return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${bytes} bytes`
}

// ─────────── Containment ───────────

async function sandboxRoot(root: string): Promise<{ realRoot: string; target: string }> {
	const realRoot = await realpathOr(root, 'the sandbox')
	return { realRoot, target: realRoot }
}

/** Resolve a user path inside the sandbox, following symlinks, and refuse anything outside. */
async function containedPath(root: string, userPath: string): Promise<{ realRoot: string; target: string }> {
	// Lexically against the root as configured (an absolute path is written in those terms),
	// then again once both sides are real paths.
	const lexical = safePathWithin(root, userPath)
	const realRoot = await realpathOr(root, 'the sandbox')
	const target = await realpathOr(lexical, userPath)
	if (!isWithin(realRoot, target)) throw new Error(`Path escapes the sandbox: ${userPath}`)
	return { realRoot, target }
}

async function realpathOr(path: string, label: string): Promise<string> {
	try {
		return await realpath(path)
	} catch (err) {
		if ((err as { code?: string }).code === 'ENOENT') throw new Error(`${label} does not exist`)
		throw err
	}
}

function isWithin(realRoot: string, path: string): boolean {
	return path === realRoot || path.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)
}

/** A glob that climbs out (`../x`) or starts somewhere else (`/etc/*`) is refused outright. */
function assertRelativePattern(pattern: string): void {
	if (isAbsolute(pattern) || /^[a-z]:/i.test(pattern) || pattern.split(/[\\/]/).includes('..')) {
		throw new Error(`Glob pattern must stay inside the sandbox: ${pattern}`)
	}
}

function toSandboxPath(realRoot: string, absolute: string): string {
	return relative(realRoot, absolute).split(sep).join('/')
}
