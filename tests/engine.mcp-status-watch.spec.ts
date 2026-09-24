import { expect, test } from '@playwright/test'
import { watchConnectorStatus, type ConnectorStatusWatchInput } from '../src/lib/engine/mcp-status-watch'

/**
 * #17 — a connector that was still connecting when the turn began, checked again as it runs.
 *
 * Pure-function tests: `src/lib/engine/mcp-status-watch.ts` imports only `./sdk-notices`, so
 * this spec needs no Postgres and no dev server. The session is a scripted `readStatus` and
 * the clock is injected.
 *
 * Why it exists: the bundled CLI starts MCP servers without blocking the turn, so a remote
 * connector is normally `pending` in `system/init`, and one that then failed was never
 * reported. What is pinned:
 *   - nothing is asked for a run with no connectors, or a session that cannot be asked
 *   - nothing is asked on `system/init` or on `result` (the SDK has closed the CLI's stdin by
 *     the time `result` reaches the loop), only once the turn is under way
 *   - asks stop once every connector has settled, are spaced out, and are capped
 *   - a connector is reported once, and init's own report counts
 *   - only this run's connectors are reported, whatever else the list contains
 *   - an ask that fails or never answers reports nothing and does not throw
 */

const init = (mcp_servers: unknown) => ({ type: 'system', subtype: 'init', tools: [], mcp_servers })
const ASSISTANT = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'hi' }] } }
const RESULT = { type: 'result', usage: {}, duration_ms: 1, num_turns: 1 }
const OURS = { name: 'agentstudio', status: 'connected', source: 'sdk' }
const server = (name: string, status: string) => ({ name, status, source: 'dynamic' })

/** A watch over a scripted session. `statuses` is what each ask returns, in turn; the last one repeats. */
function scripted(names: string[], statuses: unknown[], extra: Partial<ConnectorStatusWatchInput> = {}) {
	let clock = 0
	let asks = 0
	const watch = watchConnectorStatus({
		names,
		readStatus: async () => statuses[Math.min(asks++, statuses.length - 1)],
		now: () => clock,
		...extra,
	})
	return {
		watch,
		asks: () => asks,
		advance: (ms: number) => {
			clock += ms
		},
	}
}

test.describe('when nothing is asked', () => {
	test('a run with no connectors never asks the session', async () => {
		const run = scripted([], [[server('github', 'failed')]])
		for (const message of [init([OURS]), ASSISTANT, ASSISTANT, RESULT]) {
			expect(await run.watch.observe(message)).toBeNull()
		}
		expect(run.asks()).toBe(0)
	})

	test('a session that cannot be asked turns the watch off', async () => {
		const watch = watchConnectorStatus({ names: ['github'], readStatus: null })
		expect(await watch.observe(init([server('github', 'pending')]))).toBeNull()
		expect(await watch.observe(ASSISTANT)).toBeNull()
	})

	test('init itself is never a reason to ask, and neither is the result', async () => {
		const run = scripted(['github'], [[server('github', 'failed')]])
		expect(await run.watch.observe(init([OURS, server('github', 'pending')]))).toBeNull()
		// By the time `result` reaches the loop the SDK has closed the CLI's stdin.
		expect(await run.watch.observe(RESULT)).toBeNull()
		expect(await run.watch.observe({ type: 'system', subtype: 'compact_boundary' })).toBeNull()
		expect(run.asks()).toBe(0)
	})

	test('a connector init already reported as up or down is not asked about again', async () => {
		const run = scripted(['github', 'linear'], [[server('github', 'failed'), server('linear', 'failed')]])
		// `./sdk-notices` names github in init's own warning; linear came up.
		await run.watch.observe(init([OURS, server('github', 'failed'), server('linear', 'connected')]))
		expect(await run.watch.observe(ASSISTANT)).toBeNull()
		expect(run.asks()).toBe(0)
	})
})

test.describe('a connector still connecting when the turn began', () => {
	test('that then fails is named in one kept warning, once the turn is under way', async () => {
		const run = scripted(['github'], [[OURS, server('github', 'failed')]])
		await run.watch.observe(init([OURS, server('github', 'pending')]))

		const notice = await run.watch.observe(ASSISTANT)
		expect(run.asks()).toBe(1)
		expect(notice?.kind).toBe('mcp_unavailable')
		expect(notice?.level).toBe('warn')
		expect(notice?.persist).toBe(true)
		expect(notice?.title).toBe('A connector is unavailable this turn')
		expect(notice?.detail).toContain('github (could not connect)')

		// Settled: no further asks, and no second warning.
		run.advance(60_000)
		expect(await run.watch.observe(ASSISTANT)).toBeNull()
		expect(run.asks()).toBe(1)
	})

	test('that comes up says nothing, and is not asked about again', async () => {
		const run = scripted(['github'], [[server('github', 'connected')]])
		await run.watch.observe(init([server('github', 'pending')]))
		expect(await run.watch.observe(ASSISTANT)).toBeNull()
		run.advance(60_000)
		expect(await run.watch.observe(ASSISTANT)).toBeNull()
		expect(run.asks()).toBe(1)
	})

	test('is asked about again while it stays pending, spaced out, until it settles', async () => {
		const run = scripted(
			['github'],
			[[server('github', 'pending')], [server('github', 'pending')], [server('github', 'needs-auth')]],
			{ minIntervalMs: 2_000 },
		)
		await run.watch.observe(init([server('github', 'pending')]))

		expect(await run.watch.observe(ASSISTANT)).toBeNull()
		expect(run.asks()).toBe(1)
		// Streaming messages arrive far faster than this; they must not each cost an ask.
		run.advance(500)
		expect(await run.watch.observe({ type: 'stream_event', event: {} })).toBeNull()
		expect(run.asks()).toBe(1)

		run.advance(2_000)
		expect(await run.watch.observe({ type: 'stream_event', event: {} })).toBeNull()
		expect(run.asks()).toBe(2)

		run.advance(2_000)
		const notice = await run.watch.observe({ type: 'user', message: { content: [] } })
		expect(run.asks()).toBe(3)
		expect(notice?.detail).toContain('github (needs a sign-in)')
	})

	test('stops being asked about after the cap, even if it never settles', async () => {
		const run = scripted(['github'], [[server('github', 'pending')]], { maxChecks: 3, minIntervalMs: 0 })
		await run.watch.observe(init([server('github', 'pending')]))
		for (let i = 0; i < 10; i++) await run.watch.observe(ASSISTANT)
		expect(run.asks()).toBe(3)
	})

	test('each connector is reported once, even when a later ask lists it again', async () => {
		const run = scripted(
			['github', 'linear'],
			[
				[server('github', 'failed'), server('linear', 'pending')],
				[server('github', 'failed'), server('linear', 'failed')],
			],
			{ minIntervalMs: 0 },
		)
		await run.watch.observe(init([server('github', 'pending'), server('linear', 'pending')]))

		const first = await run.watch.observe(ASSISTANT)
		expect(first?.title).toBe('A connector is unavailable this turn')
		expect(first?.detail).toContain('github')
		expect(first?.detail).not.toContain('linear')

		const second = await run.watch.observe(ASSISTANT)
		expect(second?.title).toBe('A connector is unavailable this turn')
		expect(second?.detail).toContain('linear')
		expect(second?.detail).not.toContain('github')
	})
})

test.describe('what the answer can and cannot do', () => {
	test('only this run’s connectors are reported, and never our own server', async () => {
		const run = scripted(['github'], [
			[
				{ name: 'agentstudio', status: 'failed', source: 'sdk' },
				server('somewhere-else', 'failed'),
				server('github', 'connected'),
			],
		])
		await run.watch.observe(init([server('github', 'pending')]))
		expect(await run.watch.observe(ASSISTANT)).toBeNull()
	})

	test('a status list without `source` still counts for this run’s connectors', async () => {
		const run = scripted(['github'], [[{ name: 'github', status: 'failed' }]])
		await run.watch.observe(init([server('github', 'pending')]))
		expect((await run.watch.observe(ASSISTANT))?.detail).toContain('github (could not connect)')
	})

	test('an ask that fails, never answers or answers nonsense reports nothing and does not throw', async () => {
		const failing = watchConnectorStatus({
			names: ['github'],
			readStatus: async () => {
				throw new Error('Query closed')
			},
		})
		await failing.observe(init([server('github', 'pending')]))
		expect(await failing.observe(ASSISTANT)).toBeNull()

		const silent = watchConnectorStatus({ names: ['github'], readStatus: () => new Promise(() => {}), timeoutMs: 20 })
		await silent.observe(init([server('github', 'pending')]))
		expect(await silent.observe(ASSISTANT)).toBeNull()

		const nonsense = scripted(['github'], [{ mcpServers: 'no' }, null, 'text'], { minIntervalMs: 0 })
		for (let i = 0; i < 3; i++) expect(await nonsense.watch.observe(ASSISTANT)).toBeNull()
		for (const message of [undefined, null, 'text', 42, [], {}]) {
			expect(await nonsense.watch.observe(message)).toBeNull()
		}
	})

	test('a connector name in the answer is untrusted text and reaches the notice reduced and clipped', async () => {
		const hostile = `bad<img src=x onerror=alert(1)>${'a'.repeat(80)}`
		const run = scripted([hostile], [[server(hostile, 'failed')]])
		await run.watch.observe(init([server(hostile, 'pending')]))
		const detail = (await run.watch.observe(ASSISTANT))?.detail ?? ''
		const shown = detail.split(' (')[0]
		expect(shown).toMatch(/^[a-zA-Z0-9_-]+$/)
		expect(shown.length).toBeLessThanOrEqual(40)
		expect(detail).not.toContain('<')
	})
})
