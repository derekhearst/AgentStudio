import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	controlSessionOptions,
	RewindTimeoutError,
	withControlSession,
	type CreateRewindQuery,
	type RewindControlSource,
	type RewindFilesResult,
} from '../src/lib/engine/rewind.server'
import { buildEngineEnv } from '../src/lib/engine/engine-env'
import {
	describeRewindRefusal,
	mapRewindPreview,
	parseUncommittedPaths,
	uncommittedStatusArgs,
	workspaceRelative,
} from '../src/lib/chat/rewind-plan'
import {
	blockedPreview,
	canContinueRestore,
	restoreByDefault,
	restoreOutcomeNotice,
	shouldOfferRestore,
	unavailablePreview,
} from '../src/lib/chat/rewind-preview'
import { syntheticTranscript, writeSyntheticSession } from './sdk-transcript-fixture'

/**
 * #24 — the rewind control session and the preview it feeds.
 *
 * The first groups drive `withControlSession` through its SDK seam with a stub, and pin the
 * pure mapping. The last group runs the REAL bundled CLI against a synthetic session on disk
 * (`./sdk-transcript-fixture`): no credentials and no model call, because a control session
 * never sends a prompt. That group is what proves the design rather than assuming it — an
 * idle resumed session really answers `rewindFiles`, from the file history it loaded at
 * start-up.
 */

type StubCalls = { rewind: Array<{ id: string; dryRun: boolean }>; closed: number; prompts: AsyncIterable<unknown>[] }

function stubQuery(
	answer: (id: string, dryRun: boolean) => Promise<RewindFilesResult>,
	messages: unknown[] = [],
): { create: CreateRewindQuery; calls: StubCalls } {
	const calls: StubCalls = { rewind: [], closed: 0, prompts: [] }
	const create: CreateRewindQuery = ({ prompt }) => {
		calls.prompts.push(prompt)
		const source: RewindControlSource = {
			async *[Symbol.asyncIterator]() {
				for (const message of messages) yield message
			},
			rewindFiles: (id, options) => {
				calls.rewind.push({ id, dryRun: options?.dryRun === true })
				return answer(id, options?.dryRun === true)
			},
			close: () => {
				calls.closed += 1
			},
		}
		return source
	}
	return { create, calls }
}

test.describe('controlSessionOptions', () => {
	test('a session that can only answer control requests', async () => {
		const options = controlSessionOptions({ sessionId: 's1', cwd: '/sandbox/u/projects/p' })
		expect(options).toMatchObject({
			resume: 's1',
			cwd: '/sandbox/u/projects/p',
			enableFileCheckpointing: true,
			settingSources: [],
			tools: [],
			mcpServers: {},
			strictMcpConfig: true,
			maxTurns: 1,
		})
		const decision = await options.canUseTool!('Write', {}, { signal: new AbortController().signal, toolUseID: 't' } as never)
		expect(decision?.behavior).toBe('deny')
	})

	test('gets the engine’s allow-listed environment, never the server’s', () => {
		const previous = process.env.DATABASE_URL
		process.env.DATABASE_URL = 'postgres://secret'
		try {
			const options = controlSessionOptions({ sessionId: 's1', cwd: '/w' })
			expect(options.env).not.toHaveProperty('DATABASE_URL')
		} finally {
			if (previous === undefined) delete process.env.DATABASE_URL
			else process.env.DATABASE_URL = previous
		}
	})
})

test.describe('withControlSession', () => {
	test('never sends a prompt, and closes the session after the work', async () => {
		const { create, calls } = stubQuery(async () => ({ canRewind: true, filesChanged: [] }))
		const result = await withControlSession({ sessionId: 's', cwd: '/w', createQuery: create }, (control) =>
			control.rewindFiles('u1', { dryRun: true }),
		)
		expect(result.canRewind).toBe(true)
		expect(calls.rewind).toEqual([{ id: 'u1', dryRun: true }])
		expect(calls.closed).toBeGreaterThanOrEqual(1)

		// The input yields nothing — no user message, so no model call — and ends once closed.
		const iterator = calls.prompts[0][Symbol.asyncIterator]()
		expect(await iterator.next()).toEqual({ value: undefined, done: true })
	})

	test('closes on failure', async () => {
		const { create, calls } = stubQuery(async () => {
			throw new Error('control request failed')
		})
		await expect(
			withControlSession({ sessionId: 's', cwd: '/w', createQuery: create }, (control) => control.rewindFiles('u1')),
		).rejects.toThrow('control request failed')
		expect(calls.closed).toBeGreaterThanOrEqual(1)
	})

	test('gives up and closes when the CLI does not answer', async () => {
		const { create, calls } = stubQuery(() => new Promise<RewindFilesResult>(() => {}))
		await expect(
			withControlSession({ sessionId: 's', cwd: '/w', createQuery: create, timeoutMs: 50 }, (control) =>
				control.rewindFiles('u1', { dryRun: true }),
			),
		).rejects.toBeInstanceOf(RewindTimeoutError)
		expect(calls.closed).toBeGreaterThanOrEqual(1)
	})

	test('a CLI that could not start reports its own reason, not the transport’s', async () => {
		const { create } = stubQuery(
			async () => {
				throw new Error('Claude Code process exited with code 1')
			},
			[{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: s'] }],
		)
		await expect(
			withControlSession({ sessionId: 's', cwd: '/w', createQuery: create }, (control) => control.rewindFiles('u1')),
		).rejects.toThrow('No conversation found with session ID: s')
	})
})

test.describe('mapRewindPreview', () => {
	const root = join(tmpdir(), 'ws-root')

	test('lists files relative to the workspace, sorted, with their uncommitted flag', () => {
		const preview = mapRewindPreview({
			result: {
				canRewind: true,
				filesChanged: [join(root, 'src', 'b.ts'), join(root, 'a.txt')],
				insertions: 3,
				deletions: 7,
			},
			workspaceRoot: root,
			uncommittedPaths: new Set(['src/b.ts']),
			repoKind: 'local',
		})
		expect(preview).toMatchObject({
			available: true,
			canRewind: true,
			reason: null,
			insertions: 3,
			deletions: 7,
			outsideWorkspace: [],
			repoKind: 'local',
			// Only an imported repository needs the extra confirmation.
			requiresAcknowledge: false,
		})
		expect(preview.files).toEqual([
			{ path: 'a.txt', uncommitted: false },
			{ path: 'src/b.ts', uncommitted: true },
		])
	})

	test('an imported repository with uncommitted changes in a restored file needs an explicit yes', () => {
		const result = { canRewind: true, filesChanged: [join(root, 'a.txt')] }
		expect(
			mapRewindPreview({ result, workspaceRoot: root, uncommittedPaths: new Set(['a.txt']), repoKind: 'imported' })
				.requiresAcknowledge,
		).toBe(true)
		expect(
			mapRewindPreview({ result, workspaceRoot: root, uncommittedPaths: new Set(), repoKind: 'imported' }).requiresAcknowledge,
		).toBe(false)
		expect(
			mapRewindPreview({ result, workspaceRoot: root, uncommittedPaths: null, repoKind: null }).requiresAcknowledge,
		).toBe(false)
	})

	test('a path outside the workspace blocks the whole restore', () => {
		const outside = join(tmpdir(), 'elsewhere', 'secret.txt')
		const preview = mapRewindPreview({
			result: { canRewind: true, filesChanged: [join(root, 'a.txt'), outside] },
			workspaceRoot: root,
			uncommittedPaths: null,
			repoKind: null,
		})
		expect(preview.canRewind).toBe(false)
		expect(preview.outsideWorkspace).toEqual([outside])
		expect(preview.reason).toContain('outside the workspace')
	})

	test('the CLI’s refusal is passed on, and nothing to restore is not a restore', () => {
		const refused = mapRewindPreview({
			result: { canRewind: false, error: 'No file checkpoint found for this message.' },
			workspaceRoot: root,
			uncommittedPaths: null,
			repoKind: null,
		})
		// In the dialog's words, not the CLI's: this is what a compaction or an expired copy looks like.
		expect(refused).toMatchObject({ available: true, canRewind: false })
		expect(refused.reason).toMatch(/^There is no saved copy of the files from before this message/)

		const nothing = mapRewindPreview({
			result: { canRewind: true, filesChanged: [] },
			workspaceRoot: root,
			uncommittedPaths: null,
			repoKind: null,
		})
		expect(nothing).toMatchObject({ available: true, canRewind: false, reason: null, files: [] })
	})

	test('a file in a directory git lists as new counts as uncommitted', () => {
		const preview = mapRewindPreview({
			result: { canRewind: true, filesChanged: [join(root, 'fresh', 'deep', 'x.ts'), join(root, 'freshly.ts')] },
			workspaceRoot: root,
			uncommittedPaths: new Set(['fresh/']),
			repoKind: 'imported',
		})
		expect(preview.files).toEqual([
			{ path: 'fresh/deep/x.ts', uncommitted: true },
			{ path: 'freshly.ts', uncommitted: false },
		])
	})

	test('workspaceRelative refuses a sibling that merely shares the prefix', () => {
		expect(workspaceRelative(root, join(root, 'x', 'y.txt'))).toBe('x/y.txt')
		expect(workspaceRelative(root, `${root}-other${join('/', 'y.txt')}`)).toBeNull()
		expect(workspaceRelative(root, join(root, '..', 'y.txt'))).toBeNull()
		expect(workspaceRelative(root, root)).toBeNull()
	})
})

test.describe('what git says is uncommitted', () => {
	test('asks for every file by name, one path per entry, NUL-separated', () => {
		expect(uncommittedStatusArgs('/repo')).toEqual([
			'-C',
			'/repo',
			'status',
			'--porcelain=v1',
			'-z',
			'--untracked-files=all',
			'--no-renames',
		])
	})

	test('reads modified, staged, deleted and untracked files, spaces and all', () => {
		const stdout = [' M src/app.ts', 'M  staged.ts', ' D gone.ts', '?? notes/new file.md', 'A  added.ts', ''].join('\0')
		expect([...parseUncommittedPaths(stdout)].sort()).toEqual(['added.ts', 'gone.ts', 'notes/new file.md', 'src/app.ts', 'staged.ts'])
		expect(parseUncommittedPaths('').size).toBe(0)
	})
})

test.describe('describeRewindRefusal', () => {
	test('puts the CLI’s refusals in plain words and passes anything else through', () => {
		expect(describeRewindRefusal('No file checkpoint found for this message.')).toContain('no saved copy of the files')
		expect(describeRewindRefusal('File rewinding is not enabled.')).toBe('File checkpoints were not turned on for this message.')
		expect(describeRewindRefusal('Something new')).toBe('Something new')
		expect(describeRewindRefusal(undefined)).toBe('These files cannot be restored.')
	})
})

test.describe('the dialog’s decisions', () => {
	const restorable = mapRewindPreview({
		result: { canRewind: true, filesChanged: [join(tmpdir(), 'w', 'a.txt')] },
		workspaceRoot: join(tmpdir(), 'w'),
		uncommittedPaths: new Set(['a.txt']),
		repoKind: 'imported',
	})

	test('the option is hidden when there is nothing to restore', () => {
		expect(shouldOfferRestore(unavailablePreview())).toBe(false)
		expect(shouldOfferRestore(unavailablePreview('from an earlier session'))).toBe(false)
		expect(
			shouldOfferRestore(
				mapRewindPreview({ result: { canRewind: true, filesChanged: [] }, workspaceRoot: '/w', uncommittedPaths: null, repoKind: null }),
			),
		).toBe(false)
	})

	test('shown when a restore is possible, or when a checkpoint exists but cannot be used', () => {
		expect(shouldOfferRestore(restorable)).toBe(true)
		expect(shouldOfferRestore(blockedPreview('A reply is still being written.'))).toBe(true)
	})

	test('"also restore files" defaults on exactly when there is something to restore', () => {
		expect(restoreByDefault(restorable)).toBe(true)
		expect(restoreByDefault(blockedPreview('no'))).toBe(false)
	})

	test('Continue waits for the explicit overwrite when an imported repo has uncommitted changes', () => {
		expect(canContinueRestore(restorable, { restore: true, acknowledge: false })).toBe(false)
		expect(canContinueRestore(restorable, { restore: true, acknowledge: true })).toBe(true)
		expect(canContinueRestore(restorable, { restore: false, acknowledge: false })).toBe(true)
		expect(canContinueRestore(blockedPreview('no'), { restore: true, acknowledge: true })).toBe(false)
	})

	test('after a restore, files a link kept the CLI from restoring are named, and a full restore says nothing', () => {
		expect(restoreOutcomeNotice({ filesRestored: 3, skippedLinks: 0 })).toBeNull()
		expect(restoreOutcomeNotice({ filesRestored: 0 })).toBeNull()
		expect(restoreOutcomeNotice({ filesRestored: 4, skippedLinks: 1 })).toBe(
			'Restored 4 of 5 files. One was not restored: it is a link, or its folder moved after this message.',
		)
		expect(restoreOutcomeNotice({ filesRestored: 1, skippedLinks: 2 })).toBe(
			'Restored 1 of 3 files. 2 were not restored: they are links, or their folders moved after this message.',
		)
		expect(restoreOutcomeNotice({ filesRestored: 0, skippedLinks: 1 })).toContain('Restored 0 of 1 file.')
	})
})

test.describe('against the bundled CLI (no credentials, no model call)', () => {
	test.setTimeout(120_000)

	let base: string
	let configDir: string
	let cwd: string
	let env: Record<string, string>

	test.beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), 'agentstudio-rewind-'))
		configDir = join(base, 'config')
		cwd = join(base, 'workspace')
		mkdirSync(cwd, { recursive: true })
		env = buildEngineEnv(process.env, { CLAUDE_CONFIG_DIR: configDir })
		delete env.CLAUDE_CODE_OAUTH_TOKEN
	})

	test.afterEach(async () => {
		// `close()` does not wait for the CLI to exit, and Windows will not delete a directory
		// that is still some process's working directory. Give it a moment; a stray temp
		// directory is not worth failing a test over.
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				rmSync(base, { recursive: true, force: true })
				return
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 250))
			}
		}
	})

	test('an idle resumed session previews and restores: edits undone, created files removed', async () => {
		const sessionId = randomUUID()
		const [u1, a1, u2, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
		const t = syntheticTranscript({ sessionId, cwd })
		writeSyntheticSession({
			configDir,
			cwd,
			sessionId,
			backups: { '0123456789abcdef@v1': 'original\n' },
			entries: [
				t.user(u1, null),
				t.snapshot(u1, { 'notes.txt': '0123456789abcdef@v1' }),
				t.assistant(a1, u1),
				t.user(u2, a1),
				t.snapshot(u2, { 'notes.txt': '0123456789abcdef@v1', 'created.txt': null }),
				t.assistant(a2, u2),
			],
		})
		// What the dropped turns left on disk.
		writeFileSync(join(cwd, 'notes.txt'), 'edited by the agent\nand again\n')
		writeFileSync(join(cwd, 'created.txt'), 'new\n')

		const outcome = await withControlSession({ sessionId, cwd, env }, async (control) => {
			const dry = await control.rewindFiles(u2, { dryRun: true })
			// A dry run changes nothing.
			expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('edited by the agent\nand again\n')
			const missing = await control.rewindFiles(randomUUID(), { dryRun: true })
			const real = await control.rewindFiles(u2)
			return { dry, missing, real }
		})

		const preview = mapRewindPreview({ result: outcome.dry, workspaceRoot: cwd, uncommittedPaths: null, repoKind: null })
		expect(preview.canRewind).toBe(true)
		expect(preview.files.map((file) => file.path)).toEqual(['created.txt', 'notes.txt'])
		expect(outcome.missing).toEqual({ canRewind: false, error: 'No file checkpoint found for this message.' })
		expect(outcome.real.canRewind).toBe(true)
		expect(outcome.real.skippedLinks ?? 0).toBe(0)

		expect(readFileSync(join(cwd, 'notes.txt'), 'utf8')).toBe('original\n')
		expect(existsSync(join(cwd, 'created.txt'))).toBe(false)
	})

	test('after an edit branches the session, a plain resume follows the new branch', async () => {
		const sessionId = randomUUID()
		const [u1, a1, u2, a2, u2b, a2b] = Array.from({ length: 6 }, () => randomUUID())
		const t = syntheticTranscript({ sessionId, cwd })
		const tracked = { 'notes.txt': '0123456789abcdef@v1' }
		writeSyntheticSession({
			configDir,
			cwd,
			sessionId,
			backups: { '0123456789abcdef@v1': 'original\n' },
			entries: [
				t.user(u1, null),
				t.snapshot(u1, {}),
				t.assistant(a1, u1),
				t.user(u2, a1),
				t.snapshot(u2, tracked),
				t.assistant(a2, u2),
				// What `resumeSessionAt: a1` plus a new prompt appends.
				t.user(u2b, a1),
				t.snapshot(u2b, tracked),
				t.assistant(a2b, u2b),
			],
		})
		writeFileSync(join(cwd, 'notes.txt'), 'changed\n')

		const result = await withControlSession({ sessionId, cwd, env }, async (control) => ({
			abandoned: await control.rewindFiles(u2, { dryRun: true }),
			current: await control.rewindFiles(u2b, { dryRun: true }),
		}))
		expect(result.abandoned.canRewind).toBe(false)
		expect(result.current.canRewind).toBe(true)
	})

	test('an unknown session fails with the CLI’s reason', async () => {
		await expect(
			withControlSession({ sessionId: randomUUID(), cwd, env }, (control) => control.rewindFiles(randomUUID(), { dryRun: true })),
		).rejects.toThrow(/No conversation found with session ID/)
	})
})
