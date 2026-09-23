import { glob, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
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
 *   - every path is contained twice: lexically (`safePathWithin`), then by its real path, so
 *     a symlink inside the sandbox cannot lead a monitor outside it;
 *   - results are bounded (`MONITOR_FILE_MAX_BYTES` per file, `MONITOR_FILE_MAX_RESULTS`
 *     entries) and sorted, so an unchanged tree observes the same value on every check and
 *     `changed` means something changed.
 */

/** Directories never worth descending into; dot-directories are skipped by `**` already. */
const SKIPPED_DIRECTORIES = new Set(['node_modules'])
/** Most files a `Grep` looks inside before giving up on the rest. */
const GREP_MAX_FILES = 5_000
/** Most paths a `Glob` gathers before sorting and cutting to `MONITOR_FILE_MAX_RESULTS`. */
const GLOB_MAX_SCAN = 20_000
/** The SDK's default `head_limit`. */
const GREP_DEFAULT_LIMIT = 250

/** The monitor's filesystem: its owner's sandbox root, as the tool executor resolves it. */
export function monitorSandboxRoot(userId: string): string {
	return resolveWorkspaceRoot({ userId, sandboxRoot: process.env.SANDBOX_WORKSPACE })
}

/**
 * Run one file observation. `root` is the sandbox to observe (`monitorSandboxRoot` in
 * production, a temp directory in specs). Throws on anything that is not an observation —
 * a missing file, a path outside the sandbox, a bad pattern — so the caller records a failed
 * check rather than an empty value.
 */
export async function observeFileTool(root: string, tool: MonitorFileTool, args: Record<string, unknown>): Promise<unknown> {
	switch (tool) {
		case 'Read':
			return readFileForMonitor(root, monitorFileToolArgsSchemas.Read.parse(args))
		case 'Grep':
			return grepForMonitor(root, monitorFileToolArgsSchemas.Grep.parse(args))
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
	const found: string[] = []
	for await (const entry of glob(args.pattern, { cwd: target, exclude: isSkippedDirectory })) {
		const absolute = resolve(target, entry)
		if (!isWithin(realRoot, absolute)) continue
		found.push(toSandboxPath(realRoot, absolute))
		if (found.length >= GLOB_MAX_SCAN) break
	}
	return found.sort().slice(0, MONITOR_FILE_MAX_RESULTS)
}

// ─────────── Grep ───────────

type GrepArgs = {
	pattern: string
	path?: string
	glob?: string
	output_mode?: 'files_with_matches' | 'content' | 'count'
	'-i'?: boolean
	head_limit?: number
}

/**
 * Line-by-line regex search, in the SDK's three output shapes: matching paths (the default),
 * `{ path, line, text }` per matching line, or `{ path, count }` per file. Binary files and
 * files over the size cap are skipped, not failed.
 */
async function grepForMonitor(root: string, args: GrepArgs): Promise<unknown[]> {
	let re: RegExp
	try {
		re = new RegExp(args.pattern, args['-i'] ? 'i' : '')
	} catch {
		throw new Error(`Grep pattern is not a valid regular expression: ${args.pattern}`)
	}
	const { realRoot, target } = args.path ? await containedPath(root, args.path) : await sandboxRoot(root)
	// As in the SDK: 250 by default, 0 for "no limit" (which here is the cap).
	const limit =
		args.head_limit === undefined ? GREP_DEFAULT_LIMIT : args.head_limit === 0 ? MONITOR_FILE_MAX_RESULTS : args.head_limit
	const mode = args.output_mode ?? 'files_with_matches'

	const files = (await stat(target)).isFile() ? [target] : await filesUnder(target, realRoot, args.glob)
	const out: unknown[] = []
	for (const file of files) {
		const text = await readTextIfSmall(file, realRoot)
		if (text === null) continue
		const path = toSandboxPath(realRoot, file)
		const lines = text.split(/\r?\n/)
		if (mode === 'files_with_matches') {
			if (lines.some((line) => re.test(line))) out.push(path)
		} else if (mode === 'count') {
			const count = lines.filter((line) => re.test(line)).length
			if (count > 0) out.push({ path, count })
		} else {
			for (let i = 0; i < lines.length && out.length < limit; i++) {
				if (re.test(lines[i])) out.push({ path, line: i + 1, text: lines[i].slice(0, 300) })
			}
		}
		if (out.length >= limit) break
	}
	return out.slice(0, limit)
}

/** Files under `dir` whose name matches `nameGlob` (every file when omitted), sorted. */
async function filesUnder(dir: string, realRoot: string, nameGlob?: string): Promise<string[]> {
	// Like `rg --glob`: a bare `*.log` matches at any depth; a pattern with a slash is a path.
	const pattern = nameGlob ? (nameGlob.includes('/') ? nameGlob : `**/${nameGlob}`) : '**/*'
	assertRelativePattern(pattern)
	const files: string[] = []
	for await (const entry of glob(pattern, { cwd: dir, exclude: isSkippedDirectory })) {
		const absolute = resolve(dir, entry)
		if (isWithin(realRoot, absolute)) files.push(absolute)
		if (files.length >= GREP_MAX_FILES) break
	}
	return files.sort()
}

/** A regular file's text, or null when it is not one, is too large, is binary, or leads outside. */
async function readTextIfSmall(file: string, realRoot: string): Promise<string | null> {
	try {
		const real = await realpath(file)
		if (!isWithin(realRoot, real)) return null
		const info = await stat(real)
		if (!info.isFile() || info.size > MONITOR_FILE_MAX_BYTES) return null
		const text = await readFile(real, 'utf-8')
		return text.includes('\u0000') ? null : text
	} catch {
		// Deleted between listing and reading, or unreadable: not part of this observation.
		return null
	}
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

function isSkippedDirectory(entry: string): boolean {
	return SKIPPED_DIRECTORIES.has(basename(entry))
}

function toSandboxPath(realRoot: string, absolute: string): string {
	return relative(realRoot, absolute).split(sep).join('/')
}
