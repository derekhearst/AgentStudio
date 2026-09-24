import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getActiveUserId, getSql, uniquePrefix } from './helpers'
import { planTurn, recordTurnJoin } from '../src/lib/chat/turn-plan.server'
import { readTurnJoin } from '../src/lib/chat/turn-plan'
import { editUserMessage, truncateAfterMessage } from '../src/lib/chat/message-branch.server'
import { applyMessageRewind, previewMessageRewind, type RewindDeps } from '../src/lib/chat/rewind.server'
import { claimRun } from '../src/lib/engine/run-registry.server'
import type { CreateRewindQuery, RewindFilesResult } from '../src/lib/engine/rewind.server'

/**
 * Edit, regenerate and "also restore files" against the database (#24, and the
 * edit/regenerate fix). The pure halves are `chat.turn-plan.spec.ts` and
 * `engine.rewind.spec.ts`; these pin what the rows say and what the modules do with them.
 *
 * No model and no CLI: the rewind's control session is a stub (`createQuery`), and git is
 * a stub (`uncommittedPaths`).
 */

type Row = {
	role: 'user' | 'assistant' | 'system'
	content: string
	metadata?: Record<string, unknown>
	attachments?: unknown[]
}

async function seedThread(prefix: string, rows: Row[], opts: { sdkSessionId?: string | null; projectId?: string } = {}) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (user_id, title, model, total_tokens, total_cost, sdk_session_id, project_id)
		values (${userId}, ${`${prefix} thread`}, ${'anthropic/claude-sonnet-4'}, 0, '0', ${opts.sdkSessionId ?? null}, ${opts.projectId ?? null})
		returning id
	`
	const ids: string[] = []
	for (const [i, row] of rows.entries()) {
		const [inserted] = await sql<{ id: string }[]>`
			insert into messages (conversation_id, role, content, metadata, tool_calls, attachments, sequence)
			values (
				${conversation.id}, ${row.role}, ${row.content},
				${sql.json((row.metadata ?? {}) as never)}, '[]'::jsonb, ${sql.json((row.attachments ?? []) as never)},
				${i + 1}
			)
			returning id
		`
		ids.push(inserted.id)
	}
	return { userId, conversationId: conversation.id, ids }
}

async function rows(conversationId: string) {
	return getSql()<{ id: string; role: string; content: string; metadata: Record<string, unknown> }[]>`
		select id, role, content, metadata from messages where conversation_id = ${conversationId} order by sequence
	`
}

/** A control session that answers from a script and records what it was asked. */
function stubControl(answer: (id: string, dryRun: boolean) => Promise<RewindFilesResult> | RewindFilesResult) {
	const calls: Array<{ id: string; dryRun: boolean }> = []
	let closed = 0
	const createQuery: CreateRewindQuery = () => ({
		async *[Symbol.asyncIterator]() {},
		rewindFiles: async (id, options) => {
			calls.push({ id, dryRun: options?.dryRun === true })
			return answer(id, options?.dryRun === true)
		},
		close: () => {
			closed += 1
		},
	})
	return { createQuery, calls, closed: () => closed }
}

const SESSION = 's-current'

test.describe('planTurn: what an edited or regenerated turn sends', () => {
	test('the edited row’s own text and attachments, cut back to the reply before it', async () => {
		const prefix = uniquePrefix('regen-fork-plan')
		await cleanupPrefixedRecords(prefix)
		try {
			const attachment = { id: randomUUID(), filename: 'plan.png', mimeType: 'image/png', size: 10, url: '/api/upload/x.png' }
			const { conversationId, ids } = await seedThread(
				prefix,
				[
					{ role: 'user', content: 'What is 2+2?' },
					{ role: 'assistant', content: '4', metadata: { sdkSessionId: SESSION, sdkTailUuid: 'tail-1' } },
					{ role: 'user', content: 'What is 3+3?', attachments: [attachment] },
				],
				{ sdkSessionId: SESSION },
			)
			const planned = await planTurn({
				conversationId,
				regenerate: true,
				sdkSessionId: SESSION,
				pivotMessageId: ids[2],
				// What the page used to send. Never the prompt.
				body: { content: 'regenerate' },
			})
			expect(planned.ok).toBe(true)
			if (!planned.ok) return
			expect(planned.turn.text).toBe('What is 3+3?')
			expect(planned.turn.attachments).toEqual([attachment])
			expect(planned.turn.attempts.first).toMatchObject({ kind: 'fork', resumeSessionId: SESSION, resumeSessionAt: 'tail-1' })
			// If the CLI refuses the cut, the fallback carries exactly the kept history.
			const preamble = planned.turn.attempts.fallback?.preamble ?? ''
			expect(preamble).toContain('User: What is 2+2?')
			expect(preamble).toContain('Assistant: 4')
			expect(preamble).not.toContain('3+3')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('regenerating the first message starts a fresh session with nothing to carry', async () => {
		const prefix = uniquePrefix('regen-fork-first')
		await cleanupPrefixedRecords(prefix)
		try {
			const { conversationId, ids } = await seedThread(prefix, [{ role: 'user', content: 'hello there' }], { sdkSessionId: SESSION })
			const planned = await planTurn({ conversationId, regenerate: true, sdkSessionId: SESSION, pivotMessageId: ids[0], body: {} })
			expect(planned.ok && planned.turn.text).toBe('hello there')
			expect(planned.ok && planned.turn.attempts.first).toMatchObject({ kind: 'fresh', preamble: null })
			expect(planned.ok && planned.turn.attempts.first).not.toHaveProperty('resumeSessionId')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a reply from before the join, or from another session, gets the history as text instead', async () => {
		const prefix = uniquePrefix('regen-fork-legacy')
		await cleanupPrefixedRecords(prefix)
		try {
			const legacy = await seedThread(
				prefix,
				[
					{ role: 'user', content: 'first' },
					{ role: 'assistant', content: 'old reply', metadata: { sdkSessionId: SESSION } },
					{ role: 'user', content: 'second' },
				],
				{ sdkSessionId: SESSION },
			)
			const planned = await planTurn({
				conversationId: legacy.conversationId,
				regenerate: true,
				sdkSessionId: SESSION,
				pivotMessageId: legacy.ids[2],
				body: {},
			})
			expect(planned.ok && planned.turn.attempts.first.kind).toBe('fresh')
			expect(planned.ok && planned.turn.attempts.first.preamble).toContain('Assistant: old reply')
			expect(planned.ok && planned.turn.attempts.fallback).toBeNull()

			const moved = await seedThread(
				prefix,
				[
					{ role: 'user', content: 'first' },
					{ role: 'assistant', content: 'reply', metadata: { sdkSessionId: 's-earlier', sdkTailUuid: 't' } },
					{ role: 'user', content: 'second' },
				],
				{ sdkSessionId: SESSION },
			)
			const other = await planTurn({
				conversationId: moved.conversationId,
				regenerate: true,
				sdkSessionId: SESSION,
				pivotMessageId: moved.ids[2],
				body: {},
			})
			expect(other.ok && other.turn.attempts.first.kind).toBe('fresh')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a new message sends the request’s text and resumes the session as it is', async () => {
		const planned = await planTurn({
			conversationId: randomUUID(),
			regenerate: false,
			sdkSessionId: SESSION,
			pivotMessageId: randomUUID(),
			body: { content: 'next question' },
		})
		expect(planned.ok && planned.turn.text).toBe('next question')
		expect(planned.ok && planned.turn.attempts.first).toMatchObject({ kind: 'continue', resumeSessionId: SESSION })
	})

	test('refuses a regenerate with no user message to answer, or one from another conversation', async () => {
		const prefix = uniquePrefix('regen-fork-refuse')
		await cleanupPrefixedRecords(prefix)
		try {
			const a = await seedThread(prefix, [{ role: 'user', content: 'a' }])
			const b = await seedThread(prefix, [{ role: 'user', content: 'b' }])
			expect((await planTurn({ conversationId: a.conversationId, regenerate: true, sdkSessionId: null, pivotMessageId: null, body: {} })).ok).toBe(false)
			expect(
				(await planTurn({ conversationId: a.conversationId, regenerate: true, sdkSessionId: null, pivotMessageId: b.ids[0], body: {} })).ok,
			).toBe(false)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('recordTurnJoin', () => {
	test('stamps the user row, keeps its other metadata, and leaves assistant rows alone', async () => {
		const prefix = uniquePrefix('regen-fork-join')
		await cleanupPrefixedRecords(prefix)
		try {
			const { conversationId, ids } = await seedThread(prefix, [
				{ role: 'user', content: 'q', metadata: { keep: 'me' } },
				{ role: 'assistant', content: 'a' },
			])
			const join = { uuid: randomUUID(), sessionId: SESSION, cwd: '/w', checkpointed: true }
			await recordTurnJoin(ids[0], join)
			await recordTurnJoin(ids[1], join)
			const [user, assistant] = await rows(conversationId)
			expect(user.metadata.keep).toBe('me')
			expect(readTurnJoin(user.metadata)).toEqual(join)
			expect(assistant.metadata).toEqual({})

			// A regenerate replaces the join: the old uuid is on a branch the session left.
			const again = { ...join, uuid: randomUUID(), checkpointed: false }
			await recordTurnJoin(ids[0], again)
			expect(readTurnJoin((await rows(conversationId))[0].metadata)).toEqual(again)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('edit and regenerate, with and without restoring files', () => {
	let sandboxRoot: string
	test.beforeEach(() => {
		sandboxRoot = mkdtempSync(join(tmpdir(), 'agentstudio-regen-fork-'))
	})
	test.afterEach(() => {
		rmSync(sandboxRoot, { recursive: true, force: true })
	})

	/** A checkpointed thread whose last user message ran in `cwd`, inside the sandbox. */
	async function checkpointedThread(prefix: string, opts: { projectId?: string; cwd?: string } = {}) {
		const userId = await getActiveUserId()
		const cwd = opts.cwd ?? join(sandboxRoot, userId, 'projects', randomUUID())
		mkdirSync(cwd, { recursive: true })
		const uuid = randomUUID()
		const seeded = await seedThread(
			prefix,
			[
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'reply one', metadata: { sdkSessionId: SESSION, sdkTailUuid: 'tail-1' } },
				{ role: 'user', content: 'change the files', metadata: { sdkTurn: { uuid, sessionId: SESSION, cwd, checkpointed: true } } },
				{ role: 'assistant', content: 'changed them', metadata: { sdkSessionId: SESSION, sdkTailUuid: 'tail-2' } },
			],
			{ sdkSessionId: SESSION, projectId: opts.projectId },
		)
		return { ...seeded, cwd, uuid }
	}

	test('an edit without restoring rewrites the row and drops what came after it', async () => {
		const prefix = uniquePrefix('regen-fork-edit')
		await cleanupPrefixedRecords(prefix)
		try {
			const { userId, conversationId, ids } = await checkpointedThread(prefix)
			const result = await editUserMessage({ userId, messageId: ids[2], content: 'change them differently' })
			expect(result).toEqual({ success: true, conversationId, filesRestored: 0 })
			expect((await rows(conversationId)).map((row) => row.content)).toEqual(['first', 'reply one', 'change them differently'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('someone else’s message, or an assistant row, is not editable', async () => {
		const prefix = uniquePrefix('regen-fork-owner')
		await cleanupPrefixedRecords(prefix)
		try {
			const { userId, conversationId, ids } = await checkpointedThread(prefix)
			expect((await editUserMessage({ userId: randomUUID(), messageId: ids[2], content: 'x' })).success).toBe(false)
			expect((await editUserMessage({ userId, messageId: ids[1], content: 'x' })).success).toBe(false)
			expect(
				(await truncateAfterMessage({ userId: randomUUID(), conversationId, messageId: ids[2] })).success,
			).toBe(false)
			expect((await rows(conversationId))).toHaveLength(4)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('restoring files runs the dry run, then the restore, and only then changes the rows', async () => {
		const prefix = uniquePrefix('regen-fork-restore')
		await cleanupPrefixedRecords(prefix)
		try {
			const { userId, conversationId, ids, cwd, uuid } = await checkpointedThread(prefix)
			let rowsAtRestore = -1
			const control = stubControl(async (_id, dryRun) => {
				if (!dryRun) rowsAtRestore = (await rows(conversationId)).length
				return { canRewind: true, filesChanged: [join(cwd, 'notes.md')], insertions: 1, deletions: 4 }
			})
			const deps: RewindDeps = { createQuery: control.createQuery, sandboxRoot }

			const result = await editUserMessage({ userId, messageId: ids[2], content: 'edited', restoreFiles: true }, deps)
			expect(result).toEqual({ success: true, conversationId, filesRestored: 1 })
			expect(control.calls).toEqual([
				{ id: uuid, dryRun: true },
				{ id: uuid, dryRun: false },
			])
			expect(rowsAtRestore).toBe(4)
			expect(control.closed()).toBeGreaterThanOrEqual(1)
			expect((await rows(conversationId)).map((row) => row.content)).toEqual(['first', 'reply one', 'edited'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a restore that fails leaves the conversation exactly as it was', async () => {
		const prefix = uniquePrefix('regen-fork-restore-fails')
		await cleanupPrefixedRecords(prefix)
		try {
			const { userId, conversationId, ids, cwd } = await checkpointedThread(prefix)
			const control = stubControl((_id, dryRun) => {
				if (dryRun) return { canRewind: true, filesChanged: [join(cwd, 'a.txt')] }
				throw new Error('control request failed')
			})
			const before = await rows(conversationId)

			const regenerate = await truncateAfterMessage(
				{ userId, conversationId, messageId: ids[2], restoreFiles: true },
				{ createQuery: control.createQuery, sandboxRoot },
			)
			expect(regenerate).toMatchObject({ success: false, rewindFailed: true })
			expect(regenerate.success === false && regenerate.error).toContain('The conversation was not changed')
			expect(await rows(conversationId)).toEqual(before)

			// No checkpoint at all (the first message has no join): refused the same way.
			const edit = await editUserMessage(
				{ userId, messageId: ids[0], content: 'x', restoreFiles: true },
				{ createQuery: control.createQuery, sandboxRoot },
			)
			expect(edit).toMatchObject({ success: false, rewindFailed: true })
			expect(await rows(conversationId)).toEqual(before)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('nothing changes while a reply is still being written', async () => {
		const prefix = uniquePrefix('regen-fork-live')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		let release = () => {}
		try {
			const { userId, conversationId, ids } = await checkpointedThread(prefix)
			const [run] = await sql<{ id: string }[]>`
				insert into chat_runs (conversation_id, user_id, state, source, label, started_at)
				values (${conversationId}, ${userId}, 'running', 'chat_stream', ${`${prefix} run`}, now())
				returning id
			`
			release = claimRun(run.id)
			const control = stubControl(() => ({ canRewind: true, filesChanged: [] }))

			const edit = await editUserMessage({ userId, messageId: ids[2], content: 'x' }, { createQuery: control.createQuery, sandboxRoot })
			expect(edit).toMatchObject({ success: false, error: expect.stringContaining('still being written') })
			const preview = await previewMessageRewind({ userId, messageId: ids[2] }, { createQuery: control.createQuery, sandboxRoot })
			expect(preview).toMatchObject({ available: true, canRewind: false, reason: expect.stringContaining('still being written') })
			expect(control.calls).toEqual([])
			expect(await rows(conversationId)).toHaveLength(4)
		} finally {
			release()
			await sql`delete from chat_runs where label like ${`${prefix}%`}`
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('previewMessageRewind and applyMessageRewind', () => {
	let sandboxRoot: string
	test.beforeEach(() => {
		sandboxRoot = mkdtempSync(join(tmpdir(), 'agentstudio-rewind-preview-'))
	})
	test.afterEach(() => {
		rmSync(sandboxRoot, { recursive: true, force: true })
	})

	async function threadWithJoin(prefix: string, join: Record<string, unknown> | null, opts: { projectId?: string } = {}) {
		return seedThread(
			prefix,
			[
				{ role: 'user', content: 'change the files', metadata: join ? { sdkTurn: join } : {} },
				{ role: 'assistant', content: 'done', metadata: { sdkSessionId: SESSION, sdkTailUuid: 't' } },
			],
			{ sdkSessionId: SESSION, projectId: opts.projectId },
		)
	}

	test('the option is hidden when there is no checkpoint to go back to', async () => {
		const prefix = uniquePrefix('rewind-preview-hidden')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const inside = join(sandboxRoot, userId, 'projects', randomUUID())
			mkdirSync(inside, { recursive: true })
			const control = stubControl(() => ({ canRewind: true, filesChanged: [join(inside, 'a.txt')] }))
			const deps = { createQuery: control.createQuery, sandboxRoot }
			const base = { uuid: randomUUID(), sessionId: SESSION, cwd: inside, checkpointed: true }

			const cases = [
				// A chat with no project, or a message from before this shipped.
				null,
				{ ...base, checkpointed: false },
				// A checkpoint from an earlier session of the conversation.
				{ ...base, sessionId: 's-earlier' },
				// A working directory outside the caller's sandbox, or one that is gone.
				{ ...base, cwd: join(tmpdir(), 'elsewhere') },
				{ ...base, cwd: join(sandboxRoot, userId, 'projects', randomUUID()) },
			]
			for (const join_ of cases) {
				const { ids } = await threadWithJoin(prefix, join_)
				const preview = await previewMessageRewind({ userId, messageId: ids[0] }, deps)
				expect(preview.available).toBe(false)
				expect((await applyMessageRewind({ userId, messageId: ids[0] }, deps)).ok).toBe(false)
			}
			// Someone else's message looks exactly like one with nothing to restore.
			const { ids } = await threadWithJoin(prefix, base)
			expect((await previewMessageRewind({ userId: randomUUID(), messageId: ids[0] }, deps)).available).toBe(false)
			expect(control.calls).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('an imported repository with uncommitted changes needs an explicit yes before anything is overwritten', async () => {
		const prefix = uniquePrefix('rewind-preview-imported')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		let projectId = ''
		try {
			const userId = await getActiveUserId()
			const [project] = await sql<{ id: string }[]>`
				insert into projects (user_id, name, slug, kind, repo_kind)
				values (${userId}, ${`${prefix} repo`}, ${`regen-fork-${randomUUID().slice(0, 8)}`}, 'code'::project_kind, 'imported')
				returning id
			`
			projectId = project.id
			const checkout = join(sandboxRoot, userId, 'projects', projectId)
			mkdirSync(checkout, { recursive: true })
			await sql`update projects set repo_local_path = ${checkout} where id = ${projectId}`

			const uuid = randomUUID()
			const { ids } = await threadWithJoin(prefix, { uuid, sessionId: SESSION, cwd: checkout, checkpointed: true }, { projectId })
			const control = stubControl(() => ({
				canRewind: true,
				filesChanged: [join(checkout, 'src', 'app.ts'), join(checkout, 'new', 'file.ts')],
				insertions: 2,
				deletions: 9,
			}))
			const gitAsked: string[] = []
			const deps: RewindDeps = {
				createQuery: control.createQuery,
				sandboxRoot,
				uncommittedPaths: async (repo) => {
					gitAsked.push(repo)
					// `new/` is how git lists a whole new directory.
					return new Set(['src/app.ts', 'new/'])
				},
			}

			const preview = await previewMessageRewind({ userId, messageId: ids[0] }, deps)
			expect(preview).toMatchObject({
				available: true,
				canRewind: true,
				repoKind: 'imported',
				requiresAcknowledge: true,
				insertions: 2,
				deletions: 9,
			})
			expect(preview.files).toEqual([
				{ path: 'new/file.ts', uncommitted: true },
				{ path: 'src/app.ts', uncommitted: true },
			])
			expect(gitAsked).toEqual([checkout])

			// The server checks again: no acknowledgement, no restore.
			const refused = await applyMessageRewind({ userId, messageId: ids[0] }, deps)
			expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('uncommitted changes') })
			expect(control.calls.filter((call) => !call.dryRun)).toEqual([])

			const done = await applyMessageRewind({ userId, messageId: ids[0], acknowledgeUncommitted: true }, deps)
			expect(done).toEqual({ ok: true, filesRestored: 2, skippedLinks: 0 })
			expect(control.calls.at(-1)).toEqual({ id: uuid, dryRun: false })
		} finally {
			await cleanupPrefixedRecords(prefix)
			if (projectId) await sql`delete from projects where id = ${projectId}`
		}
	})

	test('a file outside the workspace blocks the restore, and the CLI’s refusal reads as plain words', async () => {
		const prefix = uniquePrefix('rewind-preview-refusals')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const cwd = join(sandboxRoot, userId, 'persistent', 'agent-key')
			mkdirSync(cwd, { recursive: true })
			const { ids } = await threadWithJoin(prefix, { uuid: randomUUID(), sessionId: SESSION, cwd, checkpointed: true })

			const outside = stubControl(() => ({ canRewind: true, filesChanged: [join(cwd, 'a.txt'), join(sandboxRoot, 'secret.txt')] }))
			const preview = await previewMessageRewind({ userId, messageId: ids[0] }, { createQuery: outside.createQuery, sandboxRoot })
			expect(preview).toMatchObject({ canRewind: false, outsideWorkspace: [join(sandboxRoot, 'secret.txt')] })
			const applied = await applyMessageRewind({ userId, messageId: ids[0] }, { createQuery: outside.createQuery, sandboxRoot })
			expect(applied.ok).toBe(false)
			expect(outside.calls.every((call) => call.dryRun)).toBe(true)

			const expired = stubControl(() => ({ canRewind: false, error: 'No file checkpoint found for this message.' }))
			const gone = await previewMessageRewind({ userId, messageId: ids[0] }, { createQuery: expired.createQuery, sandboxRoot })
			expect(gone).toMatchObject({ available: true, canRewind: false })
			expect(gone.reason).toContain('no saved copy of the files')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('one rewind per conversation at a time', async () => {
		const prefix = uniquePrefix('rewind-preview-busy')
		await cleanupPrefixedRecords(prefix)
		try {
			const userId = await getActiveUserId()
			const cwd = join(sandboxRoot, userId, 'projects', randomUUID())
			mkdirSync(cwd, { recursive: true })
			const { ids } = await threadWithJoin(prefix, { uuid: randomUUID(), sessionId: SESSION, cwd, checkpointed: true })
			let letGo: () => void = () => {}
			const held = new Promise<void>((resolve) => (letGo = resolve))
			const slow = stubControl(async () => {
				await held
				return { canRewind: true, filesChanged: [join(cwd, 'a.txt')] }
			})
			const deps = { createQuery: slow.createQuery, sandboxRoot }

			const first = previewMessageRewind({ userId, messageId: ids[0] }, deps)
			await expect.poll(() => slow.calls.length).toBe(1)
			const second = await previewMessageRewind({ userId, messageId: ids[0] }, deps)
			expect(second).toMatchObject({ canRewind: false, reason: expect.stringContaining('already being restored') })
			letGo()
			expect((await first).canRewind).toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
