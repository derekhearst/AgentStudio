import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { expandGroupsToToolNames, mergeAlwaysOn } from '../src/lib/tools/capabilities-core'
import { capabilityGroups } from '../src/lib/tools/tools'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

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

async function insertConversationAndRun(prefix: string, userId: string) {
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

test.describe('tools/capabilities — pure expansion', () => {
	test('expandGroupsToToolNames returns deduped tools across groups', () => {
		const tools = expandGroupsToToolNames(['core'])
		expect(tools).toContain('web_search')
		expect(tools).toContain('ask_user')
		expect(tools).toContain('propose_plan')
		expect(tools).toContain('enable_capability')
		// Only core — sandbox tools should NOT appear
		expect(tools).not.toContain('shell')
		expect(tools).not.toContain('file_write')
	})

	test('expanding multiple groups dedupes overlapping tools', () => {
		const single = expandGroupsToToolNames(['sandbox'])
		const both = expandGroupsToToolNames(['core', 'sandbox'])
		// All sandbox tools are in `both`
		for (const t of single) expect(both).toContain(t)
		// `both` adds the core tools
		expect(both).toContain('web_search')
		// `git_status` lives in sandbox per the registry
		expect(both).toContain('git_status')
		// No duplicate entries
		expect(new Set(both).size).toBe(both.length)
	})

	test('unknown group names are silently dropped (forward-compat)', () => {
		const tools = expandGroupsToToolNames(['core', 'definitely-not-a-real-group'])
		expect(tools).toContain('web_search')
		// Length matches just core
		expect(tools.length).toBe(capabilityGroups.core.tools.length)
	})
})

test.describe('tools/capabilities — pure mergeAlwaysOn', () => {
	test('always includes `core` and dedupes', () => {
		expect(mergeAlwaysOn([])).toEqual(['core'])
		expect(mergeAlwaysOn(['core'])).toEqual(['core'])
		expect(mergeAlwaysOn(['sandbox'])).toEqual(['core', 'sandbox'])
		expect(mergeAlwaysOn(['core', 'sandbox', 'core'])).toEqual(['core', 'sandbox'])
		// alwaysOn first, then user-enabled in insertion order
		expect(mergeAlwaysOn(['skills', 'sandbox'])).toEqual(['core', 'skills', 'sandbox'])
	})

	test('drops unknown group names', () => {
		expect(mergeAlwaysOn(['sandbox', 'sentinel', 'invalid'])).toEqual(['core', 'sandbox'])
	})
})

test.describe('tools/capabilities — DB column behavior (chat_runs)', () => {
	test('a fresh chat_runs row defaults `enabled_capability_groups` to ["core"]', async () => {
		const prefix = uniquePrefix('cap-default')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await insertConversationAndRun(prefix, userId)
			const [row] = await sql<{ enabled_capability_groups: string[] }[]>`
				select enabled_capability_groups from chat_runs where id = ${runId}
			`
			expect(row.enabled_capability_groups).toEqual(['core'])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('updating the column persists and round-trips through the pure helpers', async () => {
		const prefix = uniquePrefix('cap-update')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await insertConversationAndRun(prefix, userId)
			// Enable sandbox by writing the column directly (mirrors enableGroupForRun).
			await sql`
				update chat_runs set enabled_capability_groups = ${sql.json(['core', 'sandbox'])}
				where id = ${runId}
			`
			const [row] = await sql<{ enabled_capability_groups: unknown }[]>`
				select enabled_capability_groups from chat_runs where id = ${runId}
			`
			const stored = Array.isArray(row.enabled_capability_groups)
				? (row.enabled_capability_groups as string[])
				: typeof row.enabled_capability_groups === 'string'
					? (JSON.parse(row.enabled_capability_groups) as string[])
					: []
			const merged = mergeAlwaysOn(stored)
			expect(merged).toEqual(['core', 'sandbox'])
			const tools = expandGroupsToToolNames(merged)
			expect(tools).toContain('shell')
			expect(tools).toContain('git_status')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('an empty column still yields a working tool surface via mergeAlwaysOn', async () => {
		const prefix = uniquePrefix('cap-empty')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const { runId } = await insertConversationAndRun(prefix, userId)
			// Simulate a misbehaving migration / direct DB tweak that wiped the column.
			await sql`update chat_runs set enabled_capability_groups = '[]'::jsonb where id = ${runId}`
			const [row] = await sql<{ enabled_capability_groups: string[] }[]>`
				select enabled_capability_groups from chat_runs where id = ${runId}
			`
			expect(mergeAlwaysOn(row.enabled_capability_groups)).toContain('core')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
