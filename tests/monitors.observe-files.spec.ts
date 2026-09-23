import { expect, test } from '@playwright/test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MonitorRow } from '../src/lib/monitors/monitors.schema'

/**
 * Every tool a monitor offers is one it can actually run.
 *
 * The allowlist offered `Read`, `Grep` and `Glob` after the SDK built-ins replaced the
 * in-house file tools — but a monitor observes through the in-house executor, which has no
 * handler for them, so every check failed with "Unknown tool: Read" and the monitor retired
 * as `failed` after five checks without ever observing anything. `git_status` / `git_log` /
 * `git_diff` had handlers that refuse to run outside a per-run git worktree, which a monitor
 * never has. The file tools now run inside the monitor domain; the git tools are gone.
 *
 * The file tools are exercised against a temp directory standing in for the sandbox.
 */

let sandbox: string
let outside: string

test.beforeAll(async () => {
	sandbox = await mkdtemp(join(tmpdir(), 'monitor-sandbox-'))
	outside = await mkdtemp(join(tmpdir(), 'monitor-outside-'))
	await mkdir(join(sandbox, 'projects', 'p1', 'logs'), { recursive: true })
	await mkdir(join(sandbox, 'projects', 'p1', 'node_modules', 'dep'), { recursive: true })
	await writeFile(join(sandbox, 'notes.md'), 'line one\nline two\nline three\n')
	await writeFile(join(sandbox, 'projects', 'p1', 'logs', 'build.log'), 'step 1 ok\nERROR: disk full\nstep 3 ok\n')
	await writeFile(join(sandbox, 'projects', 'p1', 'logs', 'deploy.log'), 'deploying\nerror: timeout\nERROR: rollback\n')
	await writeFile(join(sandbox, 'projects', 'p1', 'report.pdf'), 'not really a pdf')
	await writeFile(join(sandbox, 'projects', 'p1', 'node_modules', 'dep', 'noise.log'), 'ERROR: ignore me\n')
	await writeFile(join(outside, 'secret.log'), 'ERROR: outside the sandbox\n')
})

test.afterAll(async () => {
	await rm(sandbox, { recursive: true, force: true })
	await rm(outside, { recursive: true, force: true })
})

test.describe('monitors/observe-files — the allowlist', () => {
	test('every observable tool is either a monitor file tool or has an executor handler', async () => {
		const { MONITOR_OBSERVABLE_TOOLS, isMonitorFileTool } = await import('../src/lib/monitors/condition')
		const { normalizeToolName } = await import('../src/lib/tools/tool-schemas')
		const { TOOL_HANDLERS } = await import('../src/lib/tools/handlers')
		for (const tool of MONITOR_OBSERVABLE_TOOLS) {
			if (isMonitorFileTool(tool)) continue
			const name = normalizeToolName(tool)
			expect(name, `${tool} is not a registry tool`).not.toBeNull()
			expect(TOOL_HANDLERS[name!], `${tool} has no handler`).toBeTruthy()
		}
	})

	test('the git tools are not offered: a monitor has no worktree to run them in', async () => {
		const { MONITOR_OBSERVABLE_TOOLS, monitorConditionSchema } = await import('../src/lib/monitors/condition')
		for (const tool of ['git_status', 'git_log', 'git_diff']) {
			expect(MONITOR_OBSERVABLE_TOOLS as readonly string[]).not.toContain(tool)
			expect(monitorConditionSchema.safeParse({ kind: 'tool_result', tool, args: {} }).success).toBe(false)
		}
	})

	test('file-tool arguments are checked when the monitor is created', async () => {
		const { monitorConditionSchema } = await import('../src/lib/monitors/condition')
		const read = (args: Record<string, unknown>) =>
			monitorConditionSchema.safeParse({ kind: 'tool_result', tool: 'Read', args, compare: 'changed' })
		expect(read({ file_path: 'notes.md' }).success).toBe(true)

		const missing = read({})
		expect(missing.success).toBe(false)
		expect(missing.error!.issues[0].path).toEqual(['args', 'file_path'])
		expect(missing.error!.issues[0].message).toMatch(/^Read arguments:/)

		// An option this implementation does not honour is refused, not silently ignored.
		expect(
			monitorConditionSchema.safeParse({ kind: 'tool_result', tool: 'Grep', args: { pattern: 'x', multiline: true } })
				.success,
		).toBe(false)
		// Same rule for a model question's context.
		expect(
			monitorConditionSchema.safeParse({
				kind: 'model_question',
				question: 'Is the build done?',
				context: [{ tool: 'Glob', args: {} }],
			}).success,
		).toBe(false)
	})
})

test.describe('monitors/observe-files — Read', () => {
	test('returns the file text, or just the requested lines', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		expect(await observeFileTool(sandbox, 'Read', { file_path: 'notes.md' })).toBe('line one\nline two\nline three\n')
		expect(await observeFileTool(sandbox, 'Read', { file_path: 'notes.md', offset: 2, limit: 1 })).toBe('line two')
		expect(await observeFileTool(sandbox, 'Read', { file_path: join(sandbox, 'notes.md') }), 'an absolute path inside').toContain(
			'line one',
		)
	})

	test('refuses a path outside the sandbox, a missing file and a directory', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		await expect(observeFileTool(sandbox, 'Read', { file_path: '../etc/passwd' })).rejects.toThrow(/escapes/i)
		await expect(observeFileTool(sandbox, 'Read', { file_path: join(outside, 'secret.log') })).rejects.toThrow(/escapes/i)
		await expect(observeFileTool(sandbox, 'Read', { file_path: 'missing.md' })).rejects.toThrow(/does not exist/)
		await expect(observeFileTool(sandbox, 'Read', { file_path: 'projects' })).rejects.toThrow(/not a file/)
	})

	test('a symlink inside the sandbox cannot lead outside it', async () => {
		const link = join(sandbox, 'escape.log')
		try {
			await symlink(join(outside, 'secret.log'), link)
		} catch {
			test.skip(true, 'this platform will not create a symlink without privileges')
		}
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		try {
			await expect(observeFileTool(sandbox, 'Read', { file_path: 'escape.log' })).rejects.toThrow(/escapes/i)
			const found = await observeFileTool(sandbox, 'Grep', { pattern: 'outside the sandbox' })
			expect(found, 'Grep does not read through it either').toEqual([])
		} finally {
			await rm(link, { force: true })
		}
	})
})

test.describe('monitors/observe-files — Glob and Grep', () => {
	test('Glob lists matching paths relative to the sandbox, sorted, without node_modules', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		expect(await observeFileTool(sandbox, 'Glob', { pattern: '**/*.log' })).toEqual([
			'projects/p1/logs/build.log',
			'projects/p1/logs/deploy.log',
		])
		expect(await observeFileTool(sandbox, 'Glob', { pattern: '*.pdf', path: 'projects/p1' })).toEqual([
			'projects/p1/report.pdf',
		])
		await expect(observeFileTool(sandbox, 'Glob', { pattern: '../**/*.log' })).rejects.toThrow(/inside the sandbox/)
	})

	test('Grep answers in the SDK’s three output shapes', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		expect(await observeFileTool(sandbox, 'Grep', { pattern: 'ERROR', glob: '*.log' })).toEqual([
			'projects/p1/logs/build.log',
			'projects/p1/logs/deploy.log',
		])
		expect(
			await observeFileTool(sandbox, 'Grep', { pattern: 'error', '-i': true, path: 'projects/p1/logs', output_mode: 'count' }),
		).toEqual([
			{ path: 'projects/p1/logs/build.log', count: 1 },
			{ path: 'projects/p1/logs/deploy.log', count: 2 },
		])
		expect(
			await observeFileTool(sandbox, 'Grep', {
				pattern: '^ERROR',
				path: 'projects/p1/logs/deploy.log',
				output_mode: 'content',
			}),
		).toEqual([{ path: 'projects/p1/logs/deploy.log', line: 3, text: 'ERROR: rollback' }])
		await expect(observeFileTool(sandbox, 'Grep', { pattern: '([' })).rejects.toThrow(/regular expression/)
	})

	test('Grep respects head_limit', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		const one = await observeFileTool(sandbox, 'Grep', { pattern: 'ERROR', head_limit: 1 })
		expect(one).toEqual(['projects/p1/logs/build.log'])
	})

	test('a linked directory is neither listed nor walked, by Glob or by Grep', async () => {
		// `fs.glob` follows links to directories, so a link to `/` let a `**/*` monitor list
		// file names anywhere on the disk. A junction needs no privileges on Windows; elsewhere
		// the type is ignored and this is an ordinary directory symlink.
		const link = join(sandbox, 'linked')
		await symlink(outside, link, 'junction')
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		try {
			for (const pattern of ['**/*', '**/*.log', '*', 'linked', 'linked/*', 'linked/**/*']) {
				const listed = (await observeFileTool(sandbox, 'Glob', { pattern })) as string[]
				expect(
					listed.filter((path) => path.startsWith('linked')),
					`Glob ${pattern} stays out of the link`,
				).toEqual([])
			}
			expect(await observeFileTool(sandbox, 'Grep', { pattern: 'outside the sandbox' })).toEqual([])
			expect(
				await observeFileTool(sandbox, 'Grep', { pattern: 'outside the sandbox', glob: 'linked/**/*' }),
				'naming the link in the glob does not get through it either',
			).toEqual([])
		} finally {
			await rm(link, { recursive: false, force: true })
		}
	})
})

test.describe('monitors/observe-files — a Grep cannot freeze the server', () => {
	let dir: string
	test.beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), 'monitor-grep-limits-'))
		// A run of `a`s ending in something else: `(a+)+$` backtracks exponentially on it.
		await writeFile(join(dir, 'evil.txt'), `${'a'.repeat(40)}b\n`)
		await writeFile(join(dir, 'long.txt'), `${'x'.repeat(15_000)}NEEDLE\nshort NEEDLE\n`)
	})
	test.afterAll(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	test('a catastrophic pattern fails the check on time, and the event loop keeps running meanwhile', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		let ticks = 0
		const ticker = setInterval(() => (ticks += 1), 50)
		const started = Date.now()
		try {
			await expect(
				observeFileTool(dir, 'Grep', { pattern: '(a+)+$', path: 'evil.txt' }, { grepTimeoutMs: 1_000 }),
			).rejects.toThrow(/took longer than 1s/)
		} finally {
			clearInterval(ticker)
		}
		expect(Date.now() - started, 'the time limit, not the regex, decides when it ends').toBeLessThan(5_000)
		expect(ticks, 'the matching ran off the event loop').toBeGreaterThan(5)
	})

	test('a search that would read too much fails instead of reading on', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		await expect(observeFileTool(dir, 'Grep', { pattern: 'NEEDLE' }, { grepMaxTotalBytes: 100 })).rejects.toThrow(
			/would read more than 100 bytes/,
		)
	})

	test('a very long line is matched on its first 10,000 characters', async () => {
		const { observeFileTool } = await import('../src/lib/monitors/observe-files.server')
		expect(
			await observeFileTool(dir, 'Grep', { pattern: 'NEEDLE', path: 'long.txt', output_mode: 'content' }),
		).toEqual([{ path: 'long.txt', line: 2, text: 'short NEEDLE' }])
	})
})

test.describe('monitors/observe-files — through the evaluator', () => {
	test('a Read monitor observes a file in its owner’s sandbox, and a retired tool says so', async () => {
		const previous = process.env.SANDBOX_WORKSPACE
		const root = await mkdtemp(join(tmpdir(), 'monitor-root-'))
		const userId = crypto.randomUUID()
		process.env.SANDBOX_WORKSPACE = root
		try {
			await mkdir(join(root, userId, 'projects', 'p1'), { recursive: true })
			const log = join(root, userId, 'projects', 'p1', 'build.log')
			await writeFile(log, 'building…\n')

			const { evaluateMonitorCondition } = await import('../src/lib/monitors/evaluate.server')
			const monitor = {
				id: crypto.randomUUID(),
				userId,
				agentId: null,
				condition: {
					kind: 'tool_result',
					tool: 'Read',
					args: { file_path: 'projects/p1/build.log' },
					compare: 'contains',
					value: 'BUILD SUCCESSFUL',
				},
				lastObservation: null,
			} as unknown as MonitorRow

			const running = await evaluateMonitorCondition(monitor)
			expect(running.outcome).toBe('observed')
			expect(running.outcome === 'observed' && running.met).toBe(false)

			await writeFile(log, 'building…\nBUILD SUCCESSFUL\n')
			const done = await evaluateMonitorCondition(monitor)
			expect(done.outcome === 'observed' && done.met).toBe(true)

			const retired = await evaluateMonitorCondition({
				...monitor,
				condition: { kind: 'tool_result', tool: 'git_status', args: {}, compare: 'changed' },
			} as unknown as MonitorRow)
			expect(retired.outcome).toBe('error')
			expect(retired.outcome === 'error' && retired.message).toContain('"git_status", which monitors can no longer run')
		} finally {
			if (previous === undefined) delete process.env.SANDBOX_WORKSPACE
			else process.env.SANDBOX_WORKSPACE = previous
			await rm(root, { recursive: true, force: true })
		}
	})
})
