import { randomUUID } from 'node:crypto'
import {
	lstat,
	mkdir,
	readdir,
	readFile as fsRead,
	rename as fsRename,
	rm,
	stat,
	writeFile as fsWrite,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { isPathWithin, resolveRealPath } from '$lib/workspace/containment.server'
import { ensureWorkspaceDir, getWorkspace, safePath, shellExec } from './sandbox.server'

/**
 * Filesystem primitives available to tools. Every entry point routes paths through
 * `safePath` (defined in sandbox.server.ts) so a tool can never escape its workspace,
 * including through a symlink that sits inside it and points out.
 *
 * `fileSearch` shells out to `rg` — it would be circular if it lived in sandbox.server.ts
 * since it needs `shellExec` from there; that's the main reason this module was split off.
 */

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
		throw new Error(
			'Invalid line range: startLine/endLine must be positive integers and endLine >= startLine',
		)
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

/** Real location of the directory entry itself: the parent resolved, the name kept. */
function realEntryPath(path: string): string {
	return join(resolveRealPath(dirname(path)), basename(path))
}

async function lstatOrNull(path: string) {
	try {
		return await lstat(path, { bigint: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
}

/**
 * Move or rename inside the workspace.
 *
 * With `overwrite`, whatever is at the target is replaced — but never destroyed before
 * the move is known to succeed. The old target is renamed aside first and only deleted
 * once the source has landed; if the move fails it is put back. Deleting first (as this
 * used to) meant a missing source, a source inside the target, or any rename error left
 * the target already gone.
 *
 * A symlink is moved as a link, not followed, which is also how `rename` treats it.
 */
export async function fileMove(fromPath: string, toPath: string, overwrite = false) {
	await ensureWorkspaceDir()
	const source = safePath(fromPath)
	const target = safePath(toPath)

	if (source === target) throw new Error(`Source and destination are the same path: ${fromPath}`)

	const sourceInfo = await lstatOrNull(source)
	if (!sourceInfo) throw new Error(`Source does not exist: ${fromPath}`)
	const targetInfo = await lstatOrNull(target)

	// The same entry under another spelling: a case-only rename on a case-insensitive disk
	// (`readme.md` → `README.md`). Nothing is being replaced, so rename it in place.
	const caseOnlyRename =
		targetInfo !== null &&
		targetInfo.ino !== 0n &&
		targetInfo.dev === sourceInfo.dev &&
		targetInfo.ino === sourceInfo.ino &&
		source.toLowerCase() === target.toLowerCase()
	if (caseOnlyRename) {
		await fsRename(source, target)
		return { fromPath, toPath }
	}

	// Compare where the two entries really live, so a symlinked parent directory cannot
	// hide that one contains the other.
	const realSource = realEntryPath(source)
	const realTarget = realEntryPath(target)
	if (isPathWithin(realSource, realTarget)) {
		throw new Error(`Cannot move ${fromPath} into itself (${toPath})`)
	}
	if (isPathWithin(realTarget, realSource)) {
		throw new Error(`Cannot replace ${toPath} with something inside it (${fromPath})`)
	}

	if (targetInfo && !overwrite) throw new Error(`Target already exists: ${toPath}`)

	await mkdir(dirname(target), { recursive: true })
	if (!targetInfo) {
		await fsRename(source, target)
		return { fromPath, toPath }
	}

	const aside = join(dirname(target), `.${basename(target)}.replaced-${randomUUID().slice(0, 8)}`)
	await fsRename(target, aside)
	try {
		await fsRename(source, target)
	} catch (error) {
		await fsRename(aside, target).catch(() => {})
		throw error
	}
	await rm(aside, { recursive: true, force: true }).catch(() => {})
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
			// lstat, not stat: a symlink is listed as itself and never walked into. Only
			// the starting directory went through `safePath`; following a link found
			// on the way down would list whatever it points at, inside the sandbox or not.
			const s = await lstat(full)
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

export async function fileStrReplace(
	path: string,
	oldStr: string,
	newStr: string,
	opts: FileReplaceOpts = {},
) {
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

	const tmpPatch = join(
		tmpdir(),
		`sandbox_patch_${Date.now()}_${Math.random().toString(36).slice(2)}.diff`,
	)
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
