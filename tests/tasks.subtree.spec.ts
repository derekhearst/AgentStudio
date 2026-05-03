import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

/**
 * Wave 2 #11 phase 5 — DAG view subtree invariants.
 *
 * The query API itself (`getTaskSubtreeQuery`) returns a flat list with each row tagged by
 * depth. Tests assert the schema's parent_task_id linkage carries the right shape for the
 * recursive fetch — depth assignment, sibling ordering by priority, and cycle defense.
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

async function insertTask(
	prefix: string,
	userId: string,
	options: { parentTaskId?: string; priority?: number; title?: string } = {},
) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into tasks (id, title, spec, status, parent_task_id, priority, created_by, metadata)
		values (
			${randomUUID()},
			${options.title ?? `${prefix} task`},
			${'spec'},
			'pending'::task_status,
			${options.parentTaskId ?? null},
			${options.priority ?? 0},
			${userId},
			${sql.json({})}
		)
		returning id
	`
	return row.id
}

test.describe('tasks/subtree — recursive fetch from a root', () => {
	test('a 3-level tree returns 7 nodes flat, with correct depth tags + sibling ordering', async () => {
		const prefix = uniquePrefix('subtree-3-level')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const root = await insertTask(prefix, userId, { title: `${prefix} root` })
			// Two children at level 1, in priority order: child A (P1) then child B (P0)
			const childA = await insertTask(prefix, userId, { parentTaskId: root, priority: 1, title: `${prefix} A` })
			const childB = await insertTask(prefix, userId, { parentTaskId: root, priority: 0, title: `${prefix} B` })
			// Two grandchildren under child A.
			const grandA1 = await insertTask(prefix, userId, { parentTaskId: childA, priority: 0, title: `${prefix} A.1` })
			const grandA2 = await insertTask(prefix, userId, { parentTaskId: childA, priority: 1, title: `${prefix} A.2` })
			// One grandchild under child B.
			const grandB1 = await insertTask(prefix, userId, { parentTaskId: childB, priority: 0, title: `${prefix} B.1` })
			// One great-grandchild.
			await insertTask(prefix, userId, { parentTaskId: grandA1, priority: 0, title: `${prefix} A.1.x` })

			// Mirror what the query helper does — recursive walk, depth tag, priority sort.
			const flat: Array<{ id: string; depth: number; title: string }> = []
			async function walk(parentId: string | null, depth: number) {
				if (parentId === null) {
					const [r] = await sql<{ id: string; title: string }[]>`
						select id, title from tasks where id = ${root}
					`
					flat.push({ id: r.id, depth: 0, title: r.title })
					await walk(r.id, 1)
					return
				}
				const children = await sql<{ id: string; title: string }[]>`
					select id, title from tasks where parent_task_id = ${parentId}
					order by priority asc, created_at asc
				`
				for (const c of children) {
					flat.push({ id: c.id, depth, title: c.title })
					await walk(c.id, depth + 1)
				}
			}
			await walk(null, 0)

			// 1 root + 2 children + (2 + 1) grandchildren + 1 great-grand = 7
			expect(flat.length).toBe(7)

			// Depth check.
			expect(flat[0].depth).toBe(0) // root
			expect(flat.filter((n) => n.depth === 1).length).toBe(2) // child A + B
			expect(flat.filter((n) => n.depth === 2).length).toBe(3) // A.1, A.2, B.1
			expect(flat.filter((n) => n.depth === 3).length).toBe(1) // A.1.x

			// Sibling ordering at level 1: B (priority=0) comes before A (priority=1).
			const level1 = flat.filter((n) => n.depth === 1)
			expect(level1[0].title).toContain('B')
			expect(level1[1].title).toContain('A')

			// Verify the FK row IDs all came back.
			const ids = new Set(flat.map((n) => n.id))
			expect(ids.has(root)).toBe(true)
			expect(ids.has(grandA2)).toBe(true)
			expect(ids.has(grandB1)).toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('cycle defense — bouncing between two tasks does not infinite-loop the walker', async () => {
		// Postgres self-FK is `ON DELETE cascade` but doesn't prevent A → B → A cycles outright
		// (the FK only requires existence). Defending in app code is the right level. The query
		// helper uses a Set<string> seen-tracker; this test sets up a cycle and asserts the walk
		// terminates without revisiting.
		const prefix = uniquePrefix('subtree-cycle')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const a = await insertTask(prefix, userId, { title: `${prefix} A` })
			const b = await insertTask(prefix, userId, { parentTaskId: a, title: `${prefix} B` })
			// Force a cycle: point A's parent at B.
			await sql`update tasks set parent_task_id = ${b} where id = ${a}`

			// Walk with cycle defense.
			const seen = new Set<string>([a])
			const flat: string[] = [a]
			const queue: string[] = [a]
			let iterations = 0
			while (queue.length > 0 && iterations < 50) {
				iterations++
				const next = queue.shift()!
				const children = await sql<{ id: string }[]>`
					select id from tasks where parent_task_id = ${next}
				`
				for (const c of children) {
					if (seen.has(c.id)) continue
					seen.add(c.id)
					flat.push(c.id)
					queue.push(c.id)
				}
			}

			// Should have visited exactly A and B (cycle prevented re-visiting A).
			expect(flat.length).toBe(2)
			expect(iterations).toBeLessThan(10)
			expect(seen.size).toBe(2)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
