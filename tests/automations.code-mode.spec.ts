import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #21 phase 4 finish — code-mode automation dispatch.
 *
 * When `automation.mode='code'` AND a `repositoryId` is set AND an `agentId` is set,
 * the runner creates a `tasks` row linked to the repo. The task runner picks it up and
 * provisions a per-attempt worktree (Wave 5 #19 P2 finish) before invoking the agent
 * loop. Code-mode automations queue work for human review — they never auto-push.
 *
 * Failure modes (no agent, no repo, stale repo) are handled gracefully: the runner logs
 * a warning + returns a marker with `taskId: null`, never throws, never falls back to
 * chat_followup behavior (we used to before the migration; this slice removes the
 * fallback noise).
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

async function seedCodingAgent(prefix: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into agents (name, role, system_prompt, model, status)
		values (${`${prefix} coder`}, 'Coding agent', 'You write code.', 'anthropic/claude-sonnet-4', 'active')
		returning id
	`
	return row.id
}

async function seedRepoForUser(prefix: string, userId: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
		values (
			${userId},
			'github',
			${`${prefix}-owner`},
			${`${prefix}-repo`},
			'https://github.com/example/repo.git',
			'main',
			'{}'::jsonb
		)
		returning id
	`
	return row.id
}

async function clearTestRows(prefix: string, agentId: string | null = null) {
	const sql = getSql()
	await sql`delete from task_attempts where task_id in (select id from tasks where title like ${`${prefix}%`})`
	await sql`delete from tasks where title like ${`${prefix}%`}`
	await sql`delete from automations where description like ${`${prefix}%`}`
	await sql`delete from repositories where owner like ${`${prefix}%`}`
	if (agentId) {
		await sql`delete from agents where id = ${agentId}`
	}
}

async function ensureNoBlockingBudget(userId: string) {
	const sql = getSql()
	await sql`delete from budget_alerts where user_id = ${userId}`
	await sql`delete from budget_limits where user_id = ${userId}`
	await sql`delete from llm_usage where user_id = ${userId} and cost::numeric > 1`
}

test.describe('automations/code-mode — happy path', () => {
	test('code mode with repo + agent creates a pending task carrying repository_id', async () => {
		const prefix = uniquePrefix('automation-code-happy')
		const sql = getSql()
		const userId = await getActiveUserId()
		await ensureNoBlockingBudget(userId)
		let agentId: string | null = null

		try {
			agentId = await seedCodingAgent(prefix)
			const repoId = await seedRepoForUser(prefix, userId)

			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (
					user_id, agent_id, description, cron_expression, prompt,
					mode, repository_id, next_run_at
				)
				values (
					${userId},
					${agentId},
					${`${prefix} code task`},
					'0 9 * * *',
					${`${prefix} refactor the foo module`},
					'code'::automation_mode,
					${repoId},
					${past}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as {
				mode?: string
				taskId?: string | null
			}
			expect(result.mode).toBe('code')
			expect(typeof result.taskId).toBe('string')

			// Task row created with the right shape: links the automation, agent, and repo.
			const [task] = await sql<{
				title: string
				spec: string
				status: string
				owner_agent_id: string | null
				repository_id: string | null
				created_by: string | null
				metadata: { source?: string; automationId?: string; mode?: string }
			}[]>`
				select title, spec, status::text as status, owner_agent_id, repository_id,
					created_by, metadata
				from tasks
				where id = ${result.taskId!}
			`
			expect(task.status).toBe('pending')
			expect(task.owner_agent_id).toBe(agentId)
			expect(task.repository_id).toBe(repoId)
			expect(task.created_by).toBe(userId)
			expect(task.title).toContain(prefix)
			expect(task.spec).toContain(`${prefix} refactor`)
			expect(task.metadata.source).toBe('automation_code')
			expect(task.metadata.automationId).toBe(automation.id)
			expect(task.metadata.mode).toBe('code')
		} finally {
			await clearTestRows(prefix, agentId)
		}
	})
})

test.describe('automations/code-mode — degraded paths', () => {
	test('code mode without repositoryId returns taskId: null (does NOT fall back to chat)', async () => {
		const prefix = uniquePrefix('automation-code-norepo')
		const sql = getSql()
		const userId = await getActiveUserId()
		await ensureNoBlockingBudget(userId)
		let agentId: string | null = null

		try {
			agentId = await seedCodingAgent(prefix)

			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, agent_id, description, cron_expression, prompt, mode, next_run_at)
				values (
					${userId}, ${agentId},
					${`${prefix} code without repo`},
					'0 9 * * *',
					${`${prefix} prompt`},
					'code'::automation_mode,
					${past}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as { mode?: string; taskId?: string | null }
			expect(result.mode).toBe('code')
			expect(result.taskId).toBeNull()

			// No task row created.
			const tasks = await sql<{ count: number }[]>`
				select count(*)::int as count from tasks where title like ${`${prefix}%`}
			`
			expect(tasks[0].count).toBe(0)
		} finally {
			await clearTestRows(prefix, agentId)
		}
	})

	test('code mode without agentId returns taskId: null (does NOT fall back to chat)', async () => {
		const prefix = uniquePrefix('automation-code-noagent')
		const sql = getSql()
		const userId = await getActiveUserId()
		await ensureNoBlockingBudget(userId)

		try {
			const repoId = await seedRepoForUser(prefix, userId)
			const past = new Date(Date.now() - 5 * 60_000)
			const [automation] = await sql<{ id: string }[]>`
				insert into automations (user_id, description, cron_expression, prompt, mode, repository_id, next_run_at)
				values (
					${userId},
					${`${prefix} code without agent`},
					'0 9 * * *',
					${`${prefix} prompt`},
					'code'::automation_mode,
					${repoId},
					${past}
				)
				returning id
			`

			const { runAutomationById } = await import('../src/lib/automations/engine')
			const result = (await runAutomationById(automation.id)) as { mode?: string; taskId?: string | null }
			expect(result.mode).toBe('code')
			expect(result.taskId).toBeNull()

			const tasks = await sql<{ count: number }[]>`
				select count(*)::int as count from tasks where title like ${`${prefix}%`}
			`
			expect(tasks[0].count).toBe(0)
		} finally {
			await clearTestRows(prefix)
		}
	})
})

test.describe('automations/code-mode — schema invariants', () => {
	test('automations.repository_id round-trips via raw SQL', async () => {
		const prefix = uniquePrefix('automation-repo-rt')
		const sql = getSql()
		const userId = await getActiveUserId()

		try {
			const repoId = await seedRepoForUser(prefix, userId)
			const [auto] = await sql<{ id: string; repository_id: string | null }[]>`
				insert into automations (user_id, description, cron_expression, prompt, repository_id)
				values (${userId}, ${`${prefix} rt`}, '0 9 * * *', 'p', ${repoId})
				returning id, repository_id
			`
			expect(auto.repository_id).toBe(repoId)
		} finally {
			await clearTestRows(prefix)
		}
	})

	test('automations_repository_idx index exists on repository_id', async () => {
		const sql = getSql()
		const [idx] = await sql<{ indexname: string }[]>`
			select indexname from pg_indexes
			where tablename = 'automations' and indexname = 'automations_repository_idx'
		`
		expect(idx?.indexname).toBe('automations_repository_idx')
	})
})
