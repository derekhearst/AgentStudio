import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { trimWithOffload, getToolOutputLimit } from '../src/lib/tools/output-offload'

async function pathExists(p: string) {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

test.describe('tools/output-offload — pure trim shape', () => {
	test('content under the per-tool limit is returned verbatim, no offload', async () => {
		const small = 'tiny shell output'
		let sinkCalls = 0
		const result = await trimWithOffload({
			toolName: 'shell',
			content: small,
			callId: 'call-1',
			offload: () => {
				sinkCalls++
			},
		})
		expect(result.visible).toBe(small)
		expect(result.offloaded).toBe(false)
		expect(result.handle).toBeNull()
		expect(result.fullSize).toBe(small.length)
		expect(sinkCalls, 'sink must NOT fire for small payloads').toBe(0)
	})

	test('shell output above the limit gets head + tail + handle, sink fires', async () => {
		const limit = getToolOutputLimit('shell')
		const big = 'A'.repeat(Math.floor(limit / 2)) + 'MIDDLE-MARKER' + 'B'.repeat(limit)
		let captured: { handle: string; size: number } | null = null
		const result = await trimWithOffload({
			toolName: 'shell',
			content: big,
			callId: 'call-shell-big',
			offload: (handle, full) => {
				captured = { handle, size: full.length }
			},
		})
		expect(result.offloaded).toBe(true)
		expect(result.handle).toBe('.tool-outputs/call-shell-big.txt')
		expect(result.fullSize).toBe(big.length)
		// The visible chunk must NOT contain the middle marker (it should be elided).
		expect(result.visible.includes('MIDDLE-MARKER')).toBe(false)
		// The visible chunk MUST mention the handle so the model can recover the full payload.
		expect(result.visible).toContain('.tool-outputs/call-shell-big.txt')
		// Visible size respects the limit.
		expect(result.visibleSize).toBeLessThanOrEqual(limit + 200) // +200 slack for the elision message itself
		// Sink fired with the full content (not the trimmed version).
		expect(captured).not.toBeNull()
		expect(captured!.handle).toBe('.tool-outputs/call-shell-big.txt')
		expect(captured!.size).toBe(big.length)
	})

	test('shell output keeps tail-heavy split (errors usually live at the end)', async () => {
		const head = 'HEADER\n'.repeat(50)
		const tail = 'STDERR-LINE\n'.repeat(2000)
		const result = await trimWithOffload({
			toolName: 'shell',
			content: head + tail,
			callId: 'call-tail-bias',
		})
		expect(result.offloaded).toBe(true)
		// Tail content must dominate — at least one STDERR-LINE must survive.
		expect(result.visible).toContain('STDERR-LINE')
	})

	test('git_log output keeps head-heavy split (newest commits matter most)', async () => {
		const newest = '2026-05-03  Newest commit subject\n'.repeat(50)
		const padding = 'X'.repeat(50_000)
		const result = await trimWithOffload({
			toolName: 'git_log',
			content: newest + padding,
			callId: 'call-git-log',
		})
		expect(result.offloaded).toBe(true)
		expect(result.visible).toContain('Newest commit subject')
	})

	test('web_search trims per-result snippets first; offloads only if still over budget', async () => {
		const results = Array.from({ length: 10 }, (_, i) => ({
			title: `Result ${i}`,
			url: `https://example.com/${i}`,
			snippet: 'X'.repeat(2000),
			content: 'Y'.repeat(2000),
		}))
		const result = await trimWithOffload({
			toolName: 'web_search',
			content: JSON.stringify(results),
			callId: 'call-web',
		})
		// The trimmed JSON should be a parseable array of 5 entries with truncated snippets.
		const parsed = JSON.parse(result.visible) as Array<{ snippet: string; content: string }>
		expect(parsed.length).toBeLessThanOrEqual(5)
		expect(parsed[0].snippet.length).toBeLessThanOrEqual(500)
		expect(parsed[0].content.length).toBeLessThanOrEqual(500)
		expect(result.offloaded).toBe(false)
	})

	test('offload sink failure does not throw — visible head+tail still returned', async () => {
		const big = 'A'.repeat(50_000)
		const result = await trimWithOffload({
			toolName: 'shell',
			content: big,
			callId: 'call-sink-fail',
			offload: () => {
				throw new Error('disk is on fire')
			},
		})
		expect(result.offloaded).toBe(true)
		expect(result.visible.length).toBeGreaterThan(0)
		// Handle is still returned because the elision message was already constructed.
		expect(result.handle).toBe('.tool-outputs/call-sink-fail.txt')
	})

	test('Infinity limit (browser_screenshot) never offloads', async () => {
		const big = 'B'.repeat(500_000)
		const result = await trimWithOffload({
			toolName: 'browser_screenshot',
			content: big,
			callId: 'call-screen',
		})
		expect(result.offloaded).toBe(false)
		expect(result.visible.length).toBe(big.length)
	})
})

test.describe('tools/output-offload — server wrapper materializes to disk', () => {
	test('the server wrapper writes the full payload to <workspace>/.tool-outputs/<callId>.txt', async () => {
		const sandboxRoot = resolve(tmpdir(), `agentstudio-offload-${randomUUID()}`)
		await mkdir(sandboxRoot, { recursive: true })
		const userId = `u${randomUUID().slice(0, 8)}`
		const runId = randomUUID()
		const callId = `c${randomUUID().slice(0, 8)}`
		const big = 'L'.repeat(50_000)
		try {
			// Manually drive the same offload contract the server wrapper uses (resolveWorkspaceRoot
			// + ensureWorkspace + write to .tool-outputs/<callId>.txt). This proves the file layout
			// without depending on $env-based config in the test process.
			const { ensureWorkspace, safePathWithin } = await import(
				'../src/lib/workspace/workspace.server'
			)
			const result = await trimWithOffload({
				toolName: 'shell',
				content: big,
				callId,
				offload: async (handle, full) => {
					const root = await ensureWorkspace({ userId, runId, sandboxRoot })
					const fullPath = safePathWithin(root, handle)
					const { mkdir: mk, writeFile } = await import('node:fs/promises')
					const { dirname } = await import('node:path')
					await mk(dirname(fullPath), { recursive: true })
					await writeFile(fullPath, full, 'utf-8')
				},
			})
			expect(result.offloaded).toBe(true)
			const expectedPath = resolve(sandboxRoot, userId, 'runs', runId, '.tool-outputs', `${callId}.txt`)
			expect(await pathExists(expectedPath), 'offloaded file should exist').toBe(true)
			const onDisk = await readFile(expectedPath, 'utf-8')
			expect(onDisk).toBe(big)
		} finally {
			await rm(sandboxRoot, { recursive: true, force: true })
		}
	})
})
