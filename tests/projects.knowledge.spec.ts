import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	readEnvVar,
	seedProject,
	uniquePrefix,
} from './helpers'
import {
	MAX_KNOWLEDGE_FILES,
	deleteKnowledgeFile,
	ensureKnowledgeDir,
	knowledgeRoot,
	listKnowledgeFiles,
	sanitizeKnowledgeFilename,
	saveKnowledgeFile,
} from '../src/lib/projects/project-knowledge.server'
import { buildProjectContextSlot } from '../src/lib/chat/stream-slots.server'

/**
 * #23 — per-project knowledge files.
 *
 * Files land at `.agentstudio/knowledge/` *inside* the project's working directory, which
 * is the design rather than an implementation detail: the agent reads them with the same
 * `Read` and `Grep` it uses for source, so there is no retrieval layer, no index, and
 * nothing to go stale. The issue ruled out a RAG index until the volume justifies one.
 *
 * Most of what is worth pinning here is refusal — a filename is the one piece of this that
 * comes from outside, and it is used to build a path.
 */

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

test.describe('projects/knowledge — filenames are the untrusted part', () => {
	test('a traversal attempt is reduced to a bare name', () => {
		// Reduced, not rejected: the last segment is a perfectly good filename, and refusing
		// outright would reject a browser that happened to send a path.
		expect(sanitizeKnowledgeFilename('../../etc/passwd')).toBe('passwd')
		expect(sanitizeKnowledgeFilename('..\\..\\windows\\system32\\config')).toBe('config')
		expect(sanitizeKnowledgeFilename('/absolute/spec.pdf')).toBe('spec.pdf')
	})

	test('a name with nothing left after reduction is refused', () => {
		for (const name of ['..', '.', '', '   ', '/', '../']) {
			expect(() => sanitizeKnowledgeFilename(name), name).toThrow()
		}
	})

	test('an executable extension is refused, with a reason the operator can act on', () => {
		// These land in the agent's own working directory, where Bash can reach them — the
		// one case where "knowledge" would be interesting to run rather than to read.
		for (const name of ['payload.sh', 'setup.EXE', 'run.ps1', 'x.bat']) {
			expect(() => sanitizeKnowledgeFilename(name), name).toThrow(/not accepted as project knowledge/)
		}
		// Everything a document could plausibly be still goes through.
		for (const name of ['spec.pdf', 'notes.md', 'export.csv', 'diagram.png', 'thread.eml', 'data.json']) {
			expect(sanitizeKnowledgeFilename(name), name).toBe(name)
		}
	})

	test('control characters are stripped rather than refused', () => {
		expect(sanitizeKnowledgeFilename('spec\u0000.pdf')).toBe('spec.pdf')
	})
})

test.describe('projects/knowledge — the directory', () => {
	test('a file round-trips, and a same-named upload replaces rather than duplicates', async () => {
		const prefix = uniquePrefix('knowledge-roundtrip')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		let projectId = ''

		try {
			const project = await seedProject(prefix)
			projectId = project.id

			await saveKnowledgeFile({
				userId,
				projectId,
				filename: 'spec.md',
				bytes: bytes('# First'),
			})
			let listed = await listKnowledgeFiles(userId, projectId)
			expect(listed.map((f) => f.name)).toEqual(['spec.md'])

			// Re-uploading a changed spec is the common case; `spec.md`, `spec-2.md`,
			// `spec-3.md` would be worse than one file the operator can reason about.
			await saveKnowledgeFile({
				userId,
				projectId,
				filename: 'spec.md',
				bytes: bytes('# Second, longer'),
			})
			listed = await listKnowledgeFiles(userId, projectId)
			expect(listed).toHaveLength(1)

			const onDisk = await readFile(join(knowledgeRoot(userId, projectId), 'spec.md'), 'utf-8')
			expect(onDisk).toBe('# Second, longer')

			expect(await deleteKnowledgeFile(userId, projectId, 'spec.md')).toBe(true)
			expect(await listKnowledgeFiles(userId, projectId)).toHaveLength(0)
			// Deleting what is not there is not an error — the listing already agrees.
			expect(await deleteKnowledgeFile(userId, projectId, 'spec.md')).toBe(false)
		} finally {
			if (projectId) await rm(knowledgeRoot(userId, projectId), { recursive: true, force: true }).catch(() => {})
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a project with no knowledge lists nothing instead of growing a directory', async () => {
		const prefix = uniquePrefix('knowledge-absent')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()

		try {
			const project = await seedProject(prefix)
			expect(await listKnowledgeFiles(userId, project.id)).toEqual([])
			// Listing must not have created it — otherwise every project grows an
			// `.agentstudio/` it never asked for.
			await expect(stat(knowledgeRoot(userId, project.id))).rejects.toThrow()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the count limit refuses a new file but still allows a replacement', async () => {
		const prefix = uniquePrefix('knowledge-limit')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		let projectId = ''

		try {
			const project = await seedProject(prefix)
			projectId = project.id
			const root = await ensureKnowledgeDir(userId, projectId)
			for (let i = 0; i < MAX_KNOWLEDGE_FILES; i++) {
				await writeFile(join(root, `file-${i}.md`), 'x')
			}

			await expect(
				saveKnowledgeFile({ userId, projectId, filename: 'one-more.md', bytes: bytes('x') }),
			).rejects.toThrow(/already holds/)

			// A project at the limit can still update what it has — the check is against the
			// names that would remain, not the count before the write.
			await saveKnowledgeFile({ userId, projectId, filename: 'file-0.md', bytes: bytes('updated') })
			expect(await readFile(join(root, 'file-0.md'), 'utf-8')).toBe('updated')
		} finally {
			if (projectId) await rm(knowledgeRoot(userId, projectId), { recursive: true, force: true }).catch(() => {})
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("a git checkout gets the directory excluded, without touching a tracked .gitignore", async () => {
		// In an imported project the working directory is somebody else's checkout. Writing
		// `.gitignore` would be an uncommitted change to a tracked file in their repo.
		const prefix = uniquePrefix('knowledge-gitexclude')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		let projectId = ''

		try {
			const project = await seedProject(prefix)
			projectId = project.id
			const sandbox = readEnvVar('SANDBOX_WORKSPACE')
			const projectPath = join(sandbox, userId, 'projects', projectId)
			await mkdir(join(projectPath, '.git', 'info'), { recursive: true })

			await ensureKnowledgeDir(userId, projectId)

			const exclude = await readFile(join(projectPath, '.git', 'info', 'exclude'), 'utf-8')
			expect(exclude).toContain('/.agentstudio/')
			await expect(stat(join(projectPath, '.gitignore'))).rejects.toThrow()

			// Idempotent: repeated uploads must not grow the file.
			await ensureKnowledgeDir(userId, projectId)
			const again = await readFile(join(projectPath, '.git', 'info', 'exclude'), 'utf-8')
			expect(again.split('/.agentstudio/').length - 1).toBe(1)
		} finally {
			if (projectId) {
				await rm(join(readEnvVar('SANDBOX_WORKSPACE'), userId, 'projects', projectId), {
					recursive: true,
					force: true,
				}).catch(() => {})
			}
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('projects/knowledge — what the agent is told', () => {
	test('the slot names the files, and says nothing when there are none', async () => {
		const prefix = uniquePrefix('knowledge-slot')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		let projectId = ''

		try {
			const project = await seedProject(prefix)
			projectId = project.id

			const before = await buildProjectContextSlot({ projectId, userId })
			expect(before?.content).not.toContain('### Project knowledge')

			await saveKnowledgeFile({ userId, projectId, filename: 'antenna-spec.pdf', bytes: bytes('%PDF') })
			const after = await buildProjectContextSlot({ projectId, userId })

			// Names only. The contents are what the file tools are for — a PDF pasted into a
			// system prompt would cost a context window to say what one `Read` says on demand.
			expect(after?.content).toContain('### Project knowledge')
			expect(after?.content).toContain('antenna-spec.pdf')
			expect(after?.content).toContain('.agentstudio/knowledge')
			expect(after?.content).not.toContain('%PDF')
		} finally {
			if (projectId) await rm(knowledgeRoot(userId, projectId), { recursive: true, force: true }).catch(() => {})
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('projects/knowledge — the endpoint', () => {
	test('upload, list and delete round-trip over HTTP', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('knowledge-http')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		let projectId = ''

		try {
			const project = await seedProject(prefix)
			projectId = project.id

			const upload = await page.request.post(`/projects/${projectId}/knowledge`, {
				multipart: {
					file: { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes') },
				},
			})
			expect(upload.status()).toBe(200)
			expect((await upload.json()).file.name).toBe('notes.md')

			expect((await listKnowledgeFiles(userId, projectId)).map((f) => f.name)).toEqual(['notes.md'])

			const removed = await page.request.delete(`/projects/${projectId}/knowledge`, {
				data: { name: 'notes.md' },
			})
			expect((await removed.json()).deleted).toBe(true)
			expect(await listKnowledgeFiles(userId, projectId)).toHaveLength(0)
		} finally {
			if (projectId) await rm(knowledgeRoot(userId, projectId), { recursive: true, force: true }).catch(() => {})
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("a project the caller does not own is a 404, not somebody else's directory", async ({ page }) => {
		const prefix = uniquePrefix('knowledge-foreign')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const sql = getSql()

		try {
			const project = await seedProject(prefix)
			// Re-owned to nobody, which is the same check a second user's project would hit.
			await sql`update projects set user_id = null where id = ${project.id}`

			const upload = await page.request.post(`/projects/${project.id}/knowledge`, {
				multipart: { file: { name: 'x.md', mimeType: 'text/markdown', buffer: Buffer.from('x') } },
			})
			expect(upload.status()).toBe(404)

			const removed = await page.request.delete(`/projects/${project.id}/knowledge`, {
				data: { name: 'x.md' },
			})
			expect(removed.status()).toBe(404)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the project page uploads, lists and removes through the panel', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('knowledge-panel')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const userId = await getActiveUserId()
		let projectId = ''

		try {
			const project = await seedProject(prefix)
			projectId = project.id
			await page.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' })

			const panel = page.getByTestId('project-knowledge')
			await panel.waitFor({ state: 'visible', timeout: 30_000 })
			await expect(panel).toContainText('Nothing attached yet.')

			await panel.getByLabel('Add knowledge files').setInputFiles({
				name: 'datasheet.md',
				mimeType: 'text/markdown',
				buffer: Buffer.from('# Datasheet'),
			})

			await expect(panel).toContainText('datasheet.md', { timeout: 20_000 })
			expect((await listKnowledgeFiles(userId, projectId)).map((f) => f.name)).toEqual(['datasheet.md'])

			await panel.getByRole('button', { name: 'Remove datasheet.md' }).click()
			await expect(panel).toContainText('Nothing attached yet.', { timeout: 20_000 })
			expect(await listKnowledgeFiles(userId, projectId)).toHaveLength(0)
		} finally {
			if (projectId) await rm(knowledgeRoot(userId, projectId), { recursive: true, force: true }).catch(() => {})
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('an unauthenticated upload never reaches the filesystem', async ({ playwright }) => {
		const context = await playwright.request.newContext()
		try {
			const response = await context.post('/projects/00000000-0000-0000-0000-000000000000/knowledge', {
				multipart: { file: { name: 'x.md', mimeType: 'text/markdown', buffer: Buffer.from('x') } },
				maxRedirects: 0,
			})
			expect([401, 302, 303]).toContain(response.status())
		} finally {
			await context.dispose()
		}
	})
})
