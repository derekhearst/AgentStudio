import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 3 #13 phase 3 — skill-based hook runner storage contract.
 *
 * Skill-based hook invocations land in `hook_invocations` with `hook_kind='skill'` and
 * `hook_ref` set to the skill name. The runner itself (`runSkillHook`) needs $env so live
 * dispatch can't be unit-tested here without booting the SvelteKit runtime; this spec covers
 * the storage shape, the missing-skill failure path, and the per-event filter the admin
 * dashboard uses to surface skill hooks separately from built-in hooks.
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

async function setupRun(prefix: string, userId: string) {
	const sql = getSql()
	const [conv] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id
	`
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (id, conversation_id, user_id, state, source, label)
		values (${randomUUID()}, ${conv.id}, ${userId}, 'completed'::chat_run_state, 'chat_stream', ${`${prefix} run`})
		returning id
	`
	return { conversationId: conv.id, runId: run.id }
}

test.describe('hooks/skill-runner — invocation log shape', () => {
	test('skill hook invocation persists with hook_kind=skill and the ref points at the skill name', async () => {
		const prefix = uniquePrefix('skill-hook-ok')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await setupRun(prefix, userId)
			const skillName = `${prefix}-after_run-handler`
			await sql`
				insert into hook_invocations (run_id, event, hook_kind, hook_ref, success, duration_ms)
				values (${runId}, 'after_run', 'skill'::hook_kind, ${skillName}, true, 412)
			`
			const [check] = await sql<{ hook_kind: string; hook_ref: string; success: boolean }[]>`
				select hook_kind::text as hook_kind, hook_ref, success from hook_invocations
				where hook_ref = ${skillName}
			`
			expect(check.hook_kind).toBe('skill')
			expect(check.hook_ref).toBe(skillName)
			expect(check.success).toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a missing-skill failure persists with the explanatory error string', async () => {
		const prefix = uniquePrefix('skill-hook-missing')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await setupRun(prefix, userId)
			const ref = `${prefix}-not-a-real-skill`
			await sql`
				insert into hook_invocations (run_id, event, hook_kind, hook_ref, success, duration_ms, error)
				values (${runId}, 'before_tool', 'skill'::hook_kind, ${ref}, false, 1, ${`skill "${ref}" not found`})
			`
			const [check] = await sql<{ success: boolean; error: string | null }[]>`
				select success, error from hook_invocations where hook_ref = ${ref}
			`
			expect(check.success).toBe(false)
			expect(check.error).toContain('not found')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('per-event filter (admin dashboard) returns only matching skill invocations', async () => {
		const prefix = uniquePrefix('skill-hook-filter')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await setupRun(prefix, userId)
			await sql`
				insert into hook_invocations (run_id, event, hook_kind, hook_ref, success, duration_ms)
				values
					(${runId}, 'after_run', 'skill'::hook_kind, ${`${prefix}-skill-a`}, true, 100),
					(${runId}, 'before_tool', 'skill'::hook_kind, ${`${prefix}-skill-b`}, true, 200),
					(${runId}, 'after_run', 'builtin'::hook_kind, ${`${prefix}-builtin`}, true, 50)
			`
			// Filter equivalent to the admin dashboard: event='after_run' AND hook_kind='skill'.
			const matches = await sql<{ hook_ref: string }[]>`
				select hook_ref from hook_invocations
				where event = 'after_run' and hook_kind = 'skill'::hook_kind and hook_ref like ${`${prefix}%`}
			`
			expect(matches).toHaveLength(1)
			expect(matches[0].hook_ref).toBe(`${prefix}-skill-a`)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
