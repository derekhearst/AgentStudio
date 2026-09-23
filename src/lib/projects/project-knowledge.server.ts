import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '$lib/observability/logger'
import { safePathWithin } from '$lib/workspace/workspace.server'
import { getProjectPath } from './project-fs.server'

/**
 * Per-project knowledge files (#23).
 *
 * Files the operator attaches to a project that are not part of its repo — a spec PDF, an
 * exported thread, a datasheet. They live at `.agentstudio/knowledge/` *inside the project's
 * working directory*, which is the whole design: the agent reads them with the same `Read`
 * and `Grep` it uses for everything else, so there is no retrieval layer, no index to keep
 * in sync, and nothing to go stale. The issue asked for exactly this and explicitly ruled
 * out a RAG index until the volume justifies one.
 *
 * ## Why the directory works for every project kind
 *
 * `resolveWorkspaceRoot` maps any conversation bound to a project onto
 * `<sandbox>/<userId>/projects/<projectId>`, whether or not that project has a repo —
 * `repo_kind = 'none'` only means there is no git checkout there, not that there is no
 * directory. So knowledge needs no special case for repo-less projects, which is the open
 * question #23 was left with.
 *
 * ## Why `.git/info/exclude` and not `.gitignore`
 *
 * In an imported project the working directory is somebody else's checkout. Writing
 * `.gitignore` would be an uncommitted modification to a tracked file in their repo — it
 * would show up in `git status`, in diffs, and eventually in a commit the agent made for an
 * unrelated reason. `.git/info/exclude` is the per-clone equivalent: it is not tracked, not
 * pushed, and invisible to the repo. Best-effort, and a failure is logged rather than
 * raised: not excluding the directory makes `git status` noisy, which is not worth failing
 * an upload over.
 */

/** Relative to the project's working directory. Both halves are created on demand. */
export const KNOWLEDGE_DIR = join('.agentstudio', 'knowledge')

/** Per file. Matches the chat attachment limit — a bigger file wants a repo, not a slot. */
export const MAX_KNOWLEDGE_FILE_BYTES = 20 * 1024 * 1024

/** Per project, so one project cannot fill the sandbox one upload at a time. */
export const MAX_KNOWLEDGE_FILES = 50

/**
 * Extensions refused on upload.
 *
 * A denylist rather than an allowlist, deliberately: "knowledge" is open-ended — a CSV, a
 * notebook, a `.eml`, a screenshot — and an allowlist would reject most of it and teach the
 * operator to work around the feature. What an allowlist would actually buy is blocking the
 * one genuinely bad case, which is a file that is interesting to *execute* rather than to
 * read: these land in the agent's own working directory, where `Bash` can reach them.
 */
const REFUSED_EXTENSIONS = new Set([
	'exe', 'dll', 'so', 'dylib', 'bin', 'com', 'msi', 'app',
	'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'scr',
])

export type KnowledgeFile = {
	name: string
	size: number
	modifiedAt: string
}

/**
 * Reduce a browser-supplied filename to something that cannot escape the directory.
 *
 * Takes the last path segment so `../../etc/passwd` and `C:\evil\x.txt` both reduce to a
 * bare name, then refuses what is left if it is empty or still relative. `safePathWithin`
 * checks the result again at the join — this is the readable refusal, that is the backstop.
 */
export function sanitizeKnowledgeFilename(raw: string): string {
	const lastSegment = String(raw ?? '')
		.split(/[\\/]/)
		.pop()
		?.trim()
	if (!lastSegment || lastSegment === '.' || lastSegment === '..') {
		throw new Error('That filename cannot be used.')
	}

	// Control characters and NUL would make a name the listing cannot render and some tools
	// cannot open; strip rather than refuse, since they are almost always a paste artefact.
	const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, '').trim()
	if (!cleaned) throw new Error('That filename cannot be used.')

	// Long enough for any real document name, short enough for every filesystem.
	const name = cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned

	const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
	if (REFUSED_EXTENSIONS.has(ext)) {
		throw new Error(
			`".${ext}" files are not accepted as project knowledge — these land in the agent's working directory, where they could be run rather than read.`,
		)
	}

	return name
}

/**
 * Absolute path to a project's knowledge directory. Does not create it.
 *
 * Validated against the project directory, not trusted: in an imported repo
 * `.agentstudio` could be a committed symlink to somewhere else on the host, and every
 * upload, listing and delete below would then happen there.
 */
export function knowledgeRoot(userId: string, projectId: string): string {
	return safePathWithin(getProjectPath(userId, projectId), KNOWLEDGE_DIR)
}

/**
 * Resolve one file inside the knowledge directory, refusing anything that escapes it.
 *
 * Two independent checks — the name is sanitized and the joined path is re-validated —
 * because they fail differently: the first gives the operator a message, the second is what
 * holds if the first is ever changed carelessly.
 */
function knowledgeFilePath(userId: string, projectId: string, filename: string): string {
	const root = knowledgeRoot(userId, projectId)
	return safePathWithin(root, sanitizeKnowledgeFilename(filename))
}

/**
 * Keep the knowledge directory out of the project's git status.
 *
 * Best effort by design — see the module note. Idempotent: the marker line is only appended
 * when it is not already there, so repeated uploads do not grow the file.
 */
async function excludeFromGit(projectPath: string): Promise<void> {
	const excludePath = join(projectPath, '.git', 'info', 'exclude')
	const marker = '/.agentstudio/'
	try {
		await stat(join(projectPath, '.git'))
	} catch {
		// No checkout here — a `repo_kind = 'none'` project. Nothing to exclude from.
		return
	}

	try {
		// The agent's Bash can write inside `.git`, so a symlinked `info/` or `exclude`
		// would otherwise turn this append into a write anywhere on the host.
		safePathWithin(projectPath, excludePath)
		await mkdir(join(projectPath, '.git', 'info'), { recursive: true })
		let current = ''
		try {
			current = await readFile(excludePath, 'utf-8')
		} catch {
			current = ''
		}
		if (current.split('\n').some((line) => line.trim() === marker)) return
		const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
		await writeFile(
			excludePath,
			`${current}${prefix}# AgentStudio project knowledge — not part of this repo\n${marker}\n`,
			'utf-8',
		)
	} catch (err) {
		logger.warn('[projects] could not exclude the knowledge directory from git', { err })
	}
}

/** Create the directory (and its git exclusion) if they are not there yet. */
export async function ensureKnowledgeDir(userId: string, projectId: string): Promise<string> {
	const root = knowledgeRoot(userId, projectId)
	await mkdir(root, { recursive: true })
	await excludeFromGit(getProjectPath(userId, projectId))
	return root
}

/**
 * List what the project carries. Sorted by name so the listing is stable between renders.
 *
 * An absent directory is an empty list, not an error: most projects never get one, and
 * creating it just to list nothing would put an `.agentstudio/` in every project.
 */
export async function listKnowledgeFiles(userId: string, projectId: string): Promise<KnowledgeFile[]> {
	let root: string
	let entries: string[]
	try {
		// Inside the try: a knowledge directory that escapes the project (see
		// `knowledgeRoot`) lists as empty rather than failing the project page. Writing
		// to it is still refused, by `ensureKnowledgeDir`.
		root = knowledgeRoot(userId, projectId)
		entries = await readdir(root)
	} catch {
		return []
	}

	const files: KnowledgeFile[] = []
	for (const name of entries) {
		try {
			// lstat: a symlink is not a knowledge file, and stat would report on its target.
			const info = await lstat(join(root, name))
			if (!info.isFile()) continue
			files.push({ name, size: info.size, modifiedAt: info.mtime.toISOString() })
		} catch {
			// Raced with a delete, or unreadable. Either way it is not in the listing.
		}
	}
	return files.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Write one file, replacing a same-named one.
 *
 * Replacing rather than de-duplicating is deliberate: re-uploading a spec after it changed
 * is the common case, and a directory of `spec.pdf`, `spec-2.pdf`, `spec-3.pdf` is worse
 * than one the operator can reason about. The count limit is checked against the names that
 * would remain, so replacing a file at the limit still works.
 */
export async function saveKnowledgeFile(input: {
	userId: string
	projectId: string
	filename: string
	bytes: Uint8Array
}): Promise<KnowledgeFile> {
	const name = sanitizeKnowledgeFilename(input.filename)

	if (input.bytes.byteLength > MAX_KNOWLEDGE_FILE_BYTES) {
		throw new Error(`"${name}" is larger than ${MAX_KNOWLEDGE_FILE_BYTES / 1024 / 1024}MB.`)
	}

	const existing = await listKnowledgeFiles(input.userId, input.projectId)
	const isReplacement = existing.some((file) => file.name === name)
	if (!isReplacement && existing.length >= MAX_KNOWLEDGE_FILES) {
		throw new Error(
			`This project already holds ${MAX_KNOWLEDGE_FILES} knowledge files. Remove one before adding another.`,
		)
	}

	await ensureKnowledgeDir(input.userId, input.projectId)
	const target = knowledgeFilePath(input.userId, input.projectId, name)
	await writeFile(target, input.bytes)

	const info = await stat(target)
	return { name, size: info.size, modifiedAt: info.mtime.toISOString() }
}

/** Remove one file. Returns false when it was not there, which is not an error. */
export async function deleteKnowledgeFile(
	userId: string,
	projectId: string,
	filename: string,
): Promise<boolean> {
	const target = knowledgeFilePath(userId, projectId, filename)
	try {
		await stat(target)
	} catch {
		return false
	}
	await rm(target, { force: true })
	return true
}
