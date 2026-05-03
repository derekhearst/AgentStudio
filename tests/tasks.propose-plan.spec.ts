import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 2 #11 phase 2 — verify the SCHEMA can hold what the propose_plan executor writes,
 * end-to-end: parent task + N children + back-linked chat_run, with the metadata payload
 * the executor encodes (source, originRunId, totals, blastRadius, etc.).
 *
 * The executor itself runs through the full chat stream + tool-approval pipeline, which is
 * exercised by the live chat tests. This spec stays at the SQL layer so it can simulate the
 * exact INSERT shape without spinning up an LLM call per assertion.
 */

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function setupConvAndRun(prefix: string, userId: string) {
	const sql = getSql()
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (id, conversation_id, user_id, state, source, label)
		values (${randomUUID()}, ${conv.id}, ${userId}, 'running'::chat_run_state, 'chat_stream', ${`${prefix} run`})
		returning id
	`
	return { conversationId: conv.id, runId: run.id }
}

test.describe('tasks/propose-plan integration — schema accepts the executor write shape', () => {
	test('parent + 3 children persist with the metadata the executor encodes; chat_run back-links', async () => {
		const prefix = uniquePrefix('propose-plan-write')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { conversationId, runId } = await setupConvAndRun(prefix, userId)

			// Mirror the executor's parent-task INSERT exactly.
			const [parent] = await sql<{ id: string }[]>`
				insert into tasks (
					id, title, spec, status, root_conversation_id, created_by, metadata
				)
				values (
					${randomUUID()},
					${`${prefix} ship the auth refactor`},
					${'# Plan\n\n## Steps\n\n1. read auth.ts\n2. extract helper\n3. add tests'},
					'running'::task_status,
					${conversationId},
					${userId},
					${sql.json({
						source: 'propose_plan',
						originRunId: runId,
						totalEstimatedCostUsd: 0.42,
						totalEstimatedDurationMin: 45,
						risks: ['breaking change for downstream callers'],
						rollback: 'git revert',
					})}
				)
				returning id
			`

			const childRows: Array<{ id: string; index: number }> = []
			for (let i = 0; i < 3; i++) {
				const [child] = await sql<{ id: string }[]>`
					insert into tasks (
						id, title, spec, status, parent_task_id, root_conversation_id, priority, created_by, metadata
					)
					values (
						${randomUUID()},
						${`Step ${i + 1}`},
						${`Detail for step ${i + 1}`},
						'pending'::task_status,
						${parent.id},
						${conversationId},
						${i},
						${userId},
						${sql.json({
							source: 'propose_plan',
							originRunId: runId,
							stepIndex: i,
							estimatedDurationMin: 15,
							estimatedCostUsd: 0.15,
							blastRadius: i === 2 ? 'shared' : 'local',
							reversible: true,
						})}
					)
					returning id
				`
				childRows.push({ id: child.id, index: i })
			}

			// Back-link the run.
			await sql`update chat_runs set task_id = ${parent.id} where id = ${runId}`

			// Assertions: parent metadata round-trip.
			const [pRow] = await sql<{
				title: string
				status: string
				root_conversation_id: string
				metadata: Record<string, unknown>
			}[]>`
				select title, status::text as status, root_conversation_id, metadata
				from tasks where id = ${parent.id}
			`
			expect(pRow.title).toContain(prefix)
			expect(pRow.status).toBe('running')
			expect(pRow.root_conversation_id).toBe(conversationId)
			expect((pRow.metadata as { originRunId?: string }).originRunId).toBe(runId)
			expect((pRow.metadata as { totalEstimatedDurationMin?: number }).totalEstimatedDurationMin).toBe(45)

			// Assertions: children link, ordered by priority.
			const children = await sql<{ id: string; priority: number; status: string; metadata: Record<string, unknown> }[]>`
				select id, priority, status::text as status, metadata from tasks
				where parent_task_id = ${parent.id}
				order by priority asc
			`
			expect(children.length).toBe(3)
			expect(children.map((c) => c.priority)).toEqual([0, 1, 2])
			expect(children.every((c) => c.status === 'pending')).toBe(true)
			expect((children[2].metadata as { blastRadius?: string }).blastRadius).toBe('shared')

			// Assertions: chat_run back-link.
			const [linked] = await sql<{ task_id: string | null }[]>`
				select task_id from chat_runs where id = ${runId}
			`
			expect(linked.task_id).toBe(parent.id)

			// Assertions: cascade — delete the parent, verify children + run pointer behavior.
			await sql`delete from tasks where id = ${parent.id}`
			const survivors = await sql<{ id: string }[]>`
				select id from tasks where id in (${parent.id}, ${childRows[0].id}, ${childRows[1].id}, ${childRows[2].id})
			`
			expect(survivors.length, 'parent + child cascade should remove all 4').toBe(0)
			const [runAfter] = await sql<{ task_id: string | null }[]>`
				select task_id from chat_runs where id = ${runId}
			`
			expect(runAfter.task_id, 'chat_run.task_id should SET NULL after parent task deletion').toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a plan with zero risks/rollback still persists (metadata fields are optional)', async () => {
		const prefix = uniquePrefix('propose-plan-minimal')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { conversationId, runId } = await setupConvAndRun(prefix, userId)
			const [parent] = await sql<{ id: string }[]>`
				insert into tasks (id, title, spec, status, root_conversation_id, created_by, metadata)
				values (
					${randomUUID()},
					${`${prefix} minimal plan`},
					${'# Just one step'},
					'running'::task_status,
					${conversationId},
					${userId},
					${sql.json({ source: 'propose_plan', originRunId: runId })}
				)
				returning id
			`
			expect(parent.id).toBeTruthy()
			// No risks/rollback fields in metadata is fine — the schema doesn't enforce shape.
			const [row] = await sql<{ metadata: Record<string, unknown> }[]>`
				select metadata from tasks where id = ${parent.id}
			`
			expect(row.metadata).toEqual({ source: 'propose_plan', originRunId: runId })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
