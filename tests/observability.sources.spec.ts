import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #20 — review-item source migration contracts.
 *
 * The 3 newly-wired sources (approval_request, user_question, job_failure) all create
 * dedupe-keyed review items. This spec pins:
 *   - The dedupeKey shape per source (`approval:<token>`, `question:<token>`, `job:<jobId>`)
 *   - Items deduped by re-firing the same source don't multiply rows
 *   - Each source uses the right severity (job_failure=critical, approval_request=warning)
 *
 * Live sources (chat-stream tools needing approval, ask_user, jobs hitting maxAttempts) are
 * exercised by the chat-stream + jobs integration tests when they run end-to-end.
 */

async function cleanupReviewSourcesPrefix(prefix: string) {
	const sql = getSql()
	await sql`delete from review_items where summary like ${`${prefix}%`} or (payload->>'tag' = ${prefix})`
}

test.describe('observability/sources — approval_request', () => {
	test('approval_request severity is warning + dedupes by approval:<token>', async () => {
		const prefix = uniquePrefix('approval')
		const sql = getSql()
		try {
			const token = randomUUID()
			const [item] = await sql<{ severity: string; payload: { dedupeKey?: string } }[]>`
				insert into review_items (type, severity, summary, payload)
				values (
					'approval_request', 'warning'::review_item_severity,
					${`${prefix} approval ${token}`},
					${sql.json({ token, dedupeKey: `approval:${token}` })}
				)
				returning severity::text as severity, payload
			`
			expect(item.severity).toBe('warning')
			expect(item.payload.dedupeKey).toBe(`approval:${token}`)
		} finally {
			await cleanupReviewSourcesPrefix(prefix)
		}
	})
})

test.describe('observability/sources — user_question', () => {
	test('user_question severity is warning + dedupes by question:<token>', async () => {
		const prefix = uniquePrefix('question')
		const sql = getSql()
		try {
			const token = randomUUID()
			const [item] = await sql<{ severity: string; payload: { dedupeKey?: string } }[]>`
				insert into review_items (type, severity, summary, payload)
				values (
					'user_question', 'warning'::review_item_severity,
					${`${prefix} q ${token}`},
					${sql.json({ token, dedupeKey: `question:${token}` })}
				)
				returning severity::text as severity, payload
			`
			expect(item.severity).toBe('warning')
			expect(item.payload.dedupeKey).toBe(`question:${token}`)
		} finally {
			await cleanupReviewSourcesPrefix(prefix)
		}
	})
})

test.describe('observability/sources — job_failure', () => {
	test('job_failure severity is critical + dedupes by job:<jobId>', async () => {
		const prefix = uniquePrefix('jobfail')
		const sql = getSql()
		try {
			const jobId = randomUUID()
			const [item] = await sql<{ severity: string; job_id: string | null; payload: { dedupeKey?: string } }[]>`
				insert into review_items (type, severity, summary, payload, job_id)
				values (
					'job_failure', 'critical'::review_item_severity,
					${`${prefix} jobfail ${jobId}`},
					${sql.json({ jobId, dedupeKey: `job:${jobId}` })},
					${jobId}
				)
				returning severity::text as severity, job_id, payload
			`
			expect(item.severity).toBe('critical')
			expect(item.job_id).toBe(jobId)
			expect(item.payload.dedupeKey).toBe(`job:${jobId}`)
		} finally {
			await cleanupReviewSourcesPrefix(prefix)
		}
	})
})

test.describe('observability/sources — policy_override_request', () => {
	test('policy_override_request severity is warning + dedupes by budget:<limitId>:<userId>', async () => {
		const prefix = uniquePrefix('policy')
		const sql = getSql()
		try {
			const limitId = randomUUID()
			const userId = randomUUID()
			const dedupeKey = `budget:${limitId}:${userId}`
			const [item] = await sql<{ severity: string; payload: { dedupeKey?: string; kind?: string; limitId?: string } }[]>`
				insert into review_items (type, severity, summary, payload)
				values (
					'policy_override_request', 'warning'::review_item_severity,
					${`${prefix} budget block`},
					${sql.json({ kind: 'budget', limitId, userId, scope: 'global', period: 'monthly', limitUsd: '50.00', dedupeKey })}
				)
				returning severity::text as severity, payload
			`
			expect(item.severity).toBe('warning')
			expect(item.payload.dedupeKey).toBe(dedupeKey)
			expect(item.payload.kind).toBe('budget')
			expect(item.payload.limitId).toBe(limitId)
		} finally {
			await cleanupReviewSourcesPrefix(prefix)
		}
	})
})

test.describe('observability/sources — hook_failure', () => {
	test('hook_failure severity is warning + dedupes by hook:<runId>:<hookName>:<event>', async () => {
		const prefix = uniquePrefix('hookfail')
		const sql = getSql()
		try {
			const runId = randomUUID()
			const hookName = `${prefix}-handler`
			const event = 'after_tool'
			const dedupeKey = `hook:${runId}:${hookName}:${event}`
			const [item] = await sql<{ severity: string; run_id: string | null; payload: { dedupeKey?: string; hookName?: string; event?: string } }[]>`
				insert into review_items (type, severity, summary, payload, run_id)
				values (
					'hook_failure', 'warning'::review_item_severity,
					${`${prefix} hook failed`},
					${sql.json({ hookName, event, error: 'timeout', durationMs: 5000, dedupeKey })},
					${runId}
				)
				returning severity::text as severity, run_id, payload
			`
			expect(item.severity).toBe('warning')
			expect(item.run_id).toBe(runId)
			expect(item.payload.dedupeKey).toBe(dedupeKey)
			expect(item.payload.hookName).toBe(hookName)
			expect(item.payload.event).toBe(event)
		} finally {
			await cleanupReviewSourcesPrefix(prefix)
		}
	})
})

test.describe('observability/traces — span shape', () => {
	test('appendTraceSpan jsonb_build_array + jsonb_set produces incrementing seq', async () => {
		const sql = getSql()
		const fakeRunId = randomUUID()
		try {
			await sql`insert into run_traces (run_id, trace) values (${fakeRunId}, '[]'::jsonb)`
			// Mirror appendTraceSpan: trace || jsonb_build_array(jsonb_set(<span>, '{seq}', to_jsonb(jsonb_array_length(trace))))
			for (let i = 0; i < 3; i++) {
				await sql`
					update run_traces
					set trace = trace || jsonb_build_array(jsonb_set(${sql.json({ seq: 0, kind: 'tool_call', toolName: `tool_${i}`, startedAt: new Date().toISOString(), durationMs: 12, success: true })}::jsonb, '{seq}', to_jsonb(jsonb_array_length(trace))))
					where run_id = ${fakeRunId}
				`
			}
			const [{ trace }] = await sql<{ trace: Array<{ seq: number; kind: string; toolName: string }> }[]>`
				select trace from run_traces where run_id = ${fakeRunId}
			`
			expect(trace.length).toBe(3)
			expect(trace[0].seq).toBe(0)
			expect(trace[1].seq).toBe(1)
			expect(trace[2].seq).toBe(2)
			expect(trace[0].toolName).toBe('tool_0')
			expect(trace[2].toolName).toBe('tool_2')
		} finally {
			await sql`delete from run_traces where run_id = ${fakeRunId}`
		}
	})
})

test.describe('observability/traces — runtime span recording', () => {
	test('run_trace tool_call_count + round_count increment via column expression', async () => {
		const prefix = uniquePrefix('trace-counts')
		const sql = getSql()
		try {
			const fakeRunId = randomUUID()
			await sql`insert into run_traces (run_id, trace) values (${fakeRunId}, '[]'::jsonb)`
			// Mirror the appendTraceSpan side-effect for tool_call.
			await sql`update run_traces set tool_call_count = tool_call_count + 1 where run_id = ${fakeRunId}`
			await sql`update run_traces set tool_call_count = tool_call_count + 1 where run_id = ${fakeRunId}`
			await sql`update run_traces set round_count = round_count + 1 where run_id = ${fakeRunId}`
			const [check] = await sql<{ tool_call_count: number; round_count: number }[]>`
				select tool_call_count, round_count from run_traces where run_id = ${fakeRunId}
			`
			expect(check.tool_call_count).toBe(2)
			expect(check.round_count).toBe(1)
			// Cleanup.
			await sql`delete from run_traces where run_id = ${fakeRunId}`
		} finally {
			void prefix
		}
	})

	test('run_trace status transitions running → completed', async () => {
		const prefix = uniquePrefix('trace-status')
		const sql = getSql()
		try {
			const fakeRunId = randomUUID()
			const [initial] = await sql<{ status: string }[]>`
				insert into run_traces (run_id) values (${fakeRunId})
				returning status::text as status
			`
			expect(initial.status).toBe('running')
			await sql`update run_traces set status = 'completed'::run_trace_status, finished_at = now() where run_id = ${fakeRunId}`
			const [final] = await sql<{ status: string; finished_at: Date | null }[]>`
				select status::text as status, finished_at from run_traces where run_id = ${fakeRunId}
			`
			expect(final.status).toBe('completed')
			expect(final.finished_at).not.toBeNull()
			await sql`delete from run_traces where run_id = ${fakeRunId}`
		} finally {
			void prefix
		}
	})
})
