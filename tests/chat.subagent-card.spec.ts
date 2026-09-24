import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, getSql, uniquePrefix } from './helpers'
import {
	formatSubagentCost,
	formatSubagentDuration,
	formatSubagentTokens,
	subagentCardEntries,
	subagentCardStats,
	subagentStatusLabel,
} from '../src/lib/chat/subagent-card'
import {
	applySubagentDelta,
	applySubagentDone,
	applySubagentStart,
	applySubagentToolCall,
	applySubagentToolResult,
	getSerializableBlocksForMetadata,
	type StreamingBlock,
	type SubagentBlock,
} from '../src/lib/chat/streaming-blocks'
import {
	MAX_TRANSCRIPT_CHARS,
	MAX_TRANSCRIPT_ENTRIES,
	appendTranscriptText,
	appendTranscriptToolCall,
	emptyTranscript,
	toolCallLabel,
} from '../src/lib/engine/subagent-transcript'
import { toolResultDetails, MAX_REPORT_CHARS, type SubagentDetails } from '../src/lib/engine/tool-result-details'

/**
 * #32 — a delegated child's card: collapsed, with the agent, how it ended, its tokens, cost
 * and duration, expanding to its own transcript.
 *
 * The pure pieces first (the typed result, the transcript, the live blocks the page builds
 * from frames, the card's wording), then the rendered card on a seeded conversation, on both
 * the desktop and the phone project.
 */

const details = (overrides: Partial<SubagentDetails> = {}): SubagentDetails => ({
	kind: 'subagent',
	tool: 'Agent',
	status: 'completed',
	sdkAgentId: 'sdk-1',
	agentType: 'reviewer',
	report: 'Looks fine.',
	reportTruncated: false,
	totalTokens: 12_345,
	totalToolUseCount: 2,
	totalDurationMs: 4_200,
	usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
	resolvedModel: 'claude-sonnet-4-5',
	...overrides,
})

test.describe("the Agent tool's typed result", () => {
	test('a completed child: report, totals and its final call usage', () => {
		const out = toolResultDetails('Agent', {
			status: 'completed',
			agentId: 'a-1',
			agentType: 'reviewer',
			content: [
				{ type: 'text', text: 'First.' },
				{ type: 'text', text: 'Second.' },
			],
			totalTokens: 900,
			totalToolUseCount: 3,
			totalDurationMs: 1_500,
			resolvedModel: 'claude-haiku-4-5',
			usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: 700 },
			prompt: 'p',
		})
		expect(out).toEqual({
			kind: 'subagent',
			tool: 'Agent',
			status: 'completed',
			sdkAgentId: 'a-1',
			agentType: 'reviewer',
			report: 'First.\n\nSecond.',
			reportTruncated: false,
			totalTokens: 900,
			totalToolUseCount: 3,
			totalDurationMs: 1_500,
			usage: { inputTokens: 10, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 700 },
			resolvedModel: 'claude-haiku-4-5',
		})
	})

	test('recognised under the old name too', () => {
		expect(toolResultDetails('Task', { status: 'completed', agentId: 'x', content: [] })?.kind).toBe('subagent')
	})

	test('launch placeholders are recognised, with no report and no usage', () => {
		const bg = toolResultDetails('Agent', { status: 'async_launched', agentId: 'bg', description: 'd', prompt: 'p', outputFile: 'o' })
		expect(bg).toMatchObject({ status: 'async_launched', sdkAgentId: 'bg', report: '', usage: null })
		const remote = toolResultDetails('Agent', { status: 'remote_launched', taskId: 'r-1', sessionUrl: 'u', description: 'd', prompt: 'p', outputFile: 'o' })
		expect(remote).toMatchObject({ status: 'remote_launched', sdkAgentId: 'r-1' })
	})

	test('a long report is capped and says so', () => {
		const out = toolResultDetails('Agent', { status: 'completed', agentId: 'x', content: [{ type: 'text', text: 'y'.repeat(MAX_REPORT_CHARS + 50) }] })
		expect(out?.kind === 'subagent' && out.report.length).toBe(MAX_REPORT_CHARS)
		expect(out?.kind === 'subagent' && out.reportTruncated).toBe(true)
	})

	test('garbage is no details, never a throw', () => {
		for (const junk of [null, 'text', 42, [], { status: 'weird' }, { content: 'x' }]) {
			expect(toolResultDetails('Agent', junk)).toBeNull()
		}
	})
})

test.describe("the child's transcript", () => {
	test('text joins text, and a call separates it', () => {
		let t = emptyTranscript()
		t = appendTranscriptText(t, 'Let me ')
		t = appendTranscriptText(t, 'look.')
		t = appendTranscriptToolCall(t, 'Read', 'a.ts')
		t = appendTranscriptText(t, 'Found it.')
		expect(t.entries).toEqual([
			{ kind: 'text', text: 'Let me look.' },
			{ kind: 'tool', name: 'Read', label: 'a.ts' },
			{ kind: 'text', text: 'Found it.' },
		])
	})

	test('a runaway child is capped, and the transcript says it was', () => {
		let t = emptyTranscript()
		t = appendTranscriptText(t, 'x'.repeat(MAX_TRANSCRIPT_CHARS + 10))
		expect(t.truncated).toBe(true)
		expect(t.entries[0].kind === 'text' && t.entries[0].text.length).toBe(MAX_TRANSCRIPT_CHARS)

		let calls = emptyTranscript()
		for (let i = 0; i < MAX_TRANSCRIPT_ENTRIES + 5; i++) calls = appendTranscriptToolCall(calls, 'Read')
		expect(calls.entries).toHaveLength(MAX_TRANSCRIPT_ENTRIES)
		expect(calls.truncated).toBe(true)
	})

	test("a call's label is a short hint, never its whole input", () => {
		expect(toolCallLabel({ file_path: 'src/a.ts', content: 'secret file body' })).toBe('src/a.ts')
		expect(toolCallLabel({ command: 'npm   test\n --watch' })).toBe('npm test --watch')
		expect(toolCallLabel({ content: 'only a body' })).toBeNull()
		expect(toolCallLabel({ command: 'x'.repeat(500) })?.length).toBe(120)
	})
})

test.describe('the live blocks the page builds from frames', () => {
	const target = { agentId: 'a1', conversationId: null }
	const start = (blocks: StreamingBlock[] = []) =>
		applySubagentStart(blocks, { agentId: 'a1', agentName: 'reviewer', conversationId: null, task: 'Review' })
	const child = (blocks: StreamingBlock[]) => blocks.find((b): b is SubagentBlock => b.kind === 'subagent')!

	test('a card opens collapsed, once, however often the start is replayed', () => {
		const blocks = start(start())
		expect(blocks).toHaveLength(1)
		expect(child(blocks)).toMatchObject({ status: 'running', expanded: false, transcript: [] })
	})

	test('frames build the transcript in order, and done carries the result', () => {
		let blocks = start()
		blocks = applySubagentToolCall(blocks, target, 'Read', 'a.ts')
		blocks = applySubagentToolResult(blocks, target, 'Read', true)
		blocks = applySubagentDelta(blocks, target, 'Fine.')
		blocks = applySubagentDone(blocks, target, { success: true, status: 'completed', details: details() })
		const block = child(blocks)
		expect(block.transcript).toEqual([
			{ kind: 'tool', name: 'Read', label: 'a.ts', success: true },
			{ kind: 'text', text: 'Fine.' },
		])
		expect(block).toMatchObject({ status: 'completed', content: 'Fine.' })
		expect(block.details?.totalTokens).toBe(12_345)
	})

	test('done without a payload is the old server: completed', () => {
		expect(child(applySubagentDone(start(), target)).status).toBe('completed')
		expect(child(applySubagentDone(start(), target, { status: 'stopped', error: 'Stopped' })).status).toBe('stopped')
	})

	test("a partial save keeps the card's transcript and marks a running child stopped", () => {
		let blocks = start()
		blocks = applySubagentDelta(blocks, target, 'half')
		const [saved] = getSerializableBlocksForMetadata(blocks)
		expect(saved).toMatchObject({
			kind: 'subagent',
			status: 'stopped',
			success: false,
			transcript: [{ kind: 'text', text: 'half' }],
		})
	})
})

test.describe("the card's wording", () => {
	test('status: a refusal reads as one', () => {
		expect(subagentStatusLabel('running')).toBe('working…')
		expect(subagentStatusLabel('completed')).toBe('done')
		expect(subagentStatusLabel('stopped')).toBe('stopped')
		expect(subagentStatusLabel('failed', 'Refused: 4 delegated agents are already running')).toBe('refused')
		expect(subagentStatusLabel('failed', 'boom')).toBe('failed')
	})

	test('tokens, cost and duration', () => {
		expect(formatSubagentTokens(950)).toBe('950 tokens')
		expect(formatSubagentTokens(12_345)).toBe('12k tokens')
		expect(formatSubagentTokens(1_234)).toBe('1.2k tokens')
		expect(formatSubagentTokens(null)).toBeNull()
		expect(formatSubagentDuration(4_200)).toBe('4.2s')
		expect(formatSubagentDuration(72_000)).toBe('1m 12s')
		// Nothing for a subscription child: "$0.00" would read as "free".
		expect(formatSubagentCost(0)).toBeNull()
		expect(formatSubagentCost(0.0123)).toBe('$0.01')
		expect(formatSubagentCost(0.004)).toBe('$0.0040')
	})

	test('the stats line leaves out what is unknown', () => {
		expect(subagentCardStats({ details: details(), costUsd: 0.25, transcript: [] })).toEqual([
			'12k tokens',
			'$0.25',
			'4.2s',
			'2 tools',
		])
		expect(subagentCardStats({ transcript: [{ kind: 'tool', name: 'Read' }] })).toEqual(['1 tool'])
	})

	test('an old block renders from its text and call names; a silent child from its report', () => {
		expect(subagentCardEntries({ content: 'said', toolCalls: [{ name: 'Read', success: true }] })).toEqual([
			{ kind: 'text', text: 'said' },
			{ kind: 'tool', name: 'Read', success: true },
		])
		expect(subagentCardEntries({ transcript: [{ kind: 'tool', name: 'Read' }], details: details() })).toEqual([
			{ kind: 'tool', name: 'Read' },
			{ kind: 'text', text: 'Looks fine.' },
		])
	})
})

async function seedConversationWithChildren(prefix: string) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [userMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls, sequence)
		values (${conversation.id}, 'user', ${`${prefix} prompt`}, 'anthropic/claude-sonnet-4', '{}'::jsonb, '[]'::jsonb, 1)
		returning id
	`
	const blocks = [
		{ kind: 'text', content: `${prefix} delegating` },
		{
			kind: 'subagent',
			agentId: 'toolu_a1',
			agentName: 'code-reviewer-with-a-rather-long-agent-name',
			conversationId: null,
			task: 'Review the authentication module for session fixation',
			content: `${prefix} the child concluded`,
			success: true,
			status: 'completed',
			transcript: [
				{ kind: 'tool', name: 'Read', label: 'src/lib/auth/session.ts', success: true },
				{ kind: 'text', text: `${prefix} the child concluded` },
			],
			details: details({ totalToolUseCount: 1 }),
			costUsd: 0.25,
		},
		{
			kind: 'subagent',
			agentId: 'toolu_a2',
			agentName: 'writer',
			conversationId: null,
			task: 'Draft notes',
			content: '',
			success: false,
			status: 'failed',
			error: 'Refused: 4 delegated agents are already running. Wait for the running children to finish, then delegate the rest.',
		},
		{ kind: 'text', content: `${prefix} done` },
	]
	await sql`
		insert into messages (conversation_id, role, content, model, parent_message_id, metadata, tool_calls, sequence)
		values (${conversation.id}, 'assistant', ${`${prefix} done`}, 'anthropic/claude-sonnet-4', ${userMsg.id},
			${sql.json({ blocks } as never)}, '[]'::jsonb, 2)
	`
	return conversation
}

test.describe('the rendered card', () => {
	test('collapsed, with agent, status, tokens, cost and duration; expands to the transcript', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('subagent-card')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		try {
			const conv = await seedConversationWithChildren(prefix)
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const cards = page.getByTestId('subagent-card').filter({ visible: true })
			await expect(cards).toHaveCount(2, { timeout: 30_000 })

			const done = cards.nth(0)
			await expect(done).toHaveAttribute('data-status', 'completed')
			await expect(done.getByTestId('subagent-card-status')).toHaveText('done')
			await expect(done.getByTestId('subagent-card-stats')).toContainText('12k tokens')
			await expect(done.getByTestId('subagent-card-stats')).toContainText('$0.25')
			await expect(done.getByTestId('subagent-card-stats')).toContainText('4.2s')
			// Collapsed: the transcript is there but not shown.
			await expect(done.getByTestId('subagent-card-transcript')).toBeHidden()

			// The name keeps a readable width on a phone, even long and beside its status.
			const name = await done.getByTestId('subagent-card-name').boundingBox()
			expect(name?.width ?? 0).toBeGreaterThan(40)
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
			expect(overflow).toBeLessThanOrEqual(1)

			await done.locator('summary').click()
			const transcript = done.getByTestId('subagent-card-transcript')
			await expect(transcript).toBeVisible()
			await expect(transcript).toContainText(`${prefix} the child concluded`)
			await expect(transcript.getByTestId('subagent-card-tool')).toContainText('src/lib/auth/session.ts')

			const refused = cards.nth(1)
			await expect(refused).toHaveAttribute('data-status', 'failed')
			await expect(refused.getByTestId('subagent-card-status')).toHaveText('refused')
			await refused.locator('summary').click()
			await expect(refused).toContainText('Wait for the running children to finish')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
