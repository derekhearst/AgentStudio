import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedProject,
	uniquePrefix,
} from './helpers'
import { buildProjectContextSlot } from '../src/lib/chat/stream-slots.server'

/**
 * #23 — per-project standing instructions.
 *
 * The issue proposed a `CLAUDE.md` in the working directory as the primary form, with a
 * database field as the fallback for `repo_kind = 'none'`. The trust work in the same PR
 * makes that the wrong way round: `CLAUDE.md` only loads when `settingSources` includes
 * `'project'`, which `projects.settings_trusted` gates — so an operator's own instructions,
 * routed through that file, would silently stop loading for any project whose *repo* config
 * they had not accepted. Those are different questions, and only one of them should be
 * gated. So the operator's words go through the project-context slot, which is never gated,
 * and a repo's own `CLAUDE.md` still loads on the trusted path. When both exist they
 * compose.
 *
 * These drive the slot builder directly — no model, no page — plus one pass over the panel
 * that writes the column.
 */

async function setInstructions(projectId: string, instructions: string | null) {
	const sql = getSql()
	await sql`update projects set instructions = ${instructions} where id = ${projectId}`
}

test.describe('projects/instructions — what reaches the system prompt', () => {
	test('instructions are injected under their own heading', async () => {
		const prefix = uniquePrefix('proj-instructions')
		await cleanupPrefixedRecords(prefix)

		try {
			const project = await seedProject(prefix, { description: 'A description' })
			await setInstructions(project.id, 'Always run `bun run check` before claiming a change is done.')

			const slot = await buildProjectContextSlot({
				projectId: project.id,
				userId: await getActiveUserId(),
			})

			expect(slot?.name).toBe('project_context')
			expect(slot?.content).toContain('### Project instructions')
			expect(slot?.content).toContain('Always run `bun run check`')
			// The description is a different field and keeps its own place.
			expect(slot?.content).toContain('A description')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('no instructions means no heading — not an empty section in every prompt', async () => {
		const prefix = uniquePrefix('proj-instructions-empty')
		await cleanupPrefixedRecords(prefix)

		try {
			const project = await seedProject(prefix)
			const userId = await getActiveUserId()

			const blank = await buildProjectContextSlot({ projectId: project.id, userId })
			expect(blank?.content).not.toContain('### Project instructions')

			// Whitespace is "none" too: a textarea the operator cleared should cost nothing.
			await setInstructions(project.id, '   \n  ')
			const whitespace = await buildProjectContextSlot({ projectId: project.id, userId })
			expect(whitespace?.content).not.toContain('### Project instructions')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('instructions load whether or not the project is trusted', async () => {
		// The whole reason these do not live in a `CLAUDE.md`. Trust decides whether the
		// *repo's* committed config loads; it must not decide whether the operator's own
		// words do.
		const prefix = uniquePrefix('proj-instructions-untrusted')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()

		try {
			const project = await seedProject(prefix)
			const userId = await getActiveUserId()
			await setInstructions(project.id, 'Prefer small commits.')

			await sql`update projects set settings_trusted = false where id = ${project.id}`
			expect((await buildProjectContextSlot({ projectId: project.id, userId }))?.content).toContain(
				'Prefer small commits.',
			)

			await sql`update projects set settings_trusted = true where id = ${project.id}`
			expect((await buildProjectContextSlot({ projectId: project.id, userId }))?.content).toContain(
				'Prefer small commits.',
			)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("another user's project yields no slot at all", async () => {
		const prefix = uniquePrefix('proj-instructions-foreign')
		await cleanupPrefixedRecords(prefix)

		try {
			const project = await seedProject(prefix)
			await setInstructions(project.id, 'Secret conventions.')

			const slot = await buildProjectContextSlot({
				projectId: project.id,
				userId: '00000000-0000-0000-0000-000000000000',
			})
			expect(slot).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('projects/instructions — the panel that writes them', () => {
	test('saving from the project page persists, and clearing removes the column value', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('proj-instructions-ui')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const sql = getSql()

		try {
			const project = await seedProject(prefix)
			await page.goto(`/projects/${project.id}`, { waitUntil: 'domcontentloaded' })

			const field = page.getByLabel('Project instructions')
			await field.waitFor({ state: 'visible', timeout: 30_000 })
			await field.fill('Write tests before saying it works.')
			await page.getByRole('button', { name: 'Save instructions' }).click()

			await expect
				.poll(
					async () => {
						const [row] = await sql<{ instructions: string | null }[]>`
							select instructions from projects where id = ${project.id}
						`
						return row?.instructions ?? null
					},
					{ timeout: 20_000 },
				)
				.toBe('Write tests before saying it works.')

			// Emptying the box means "none", not an empty instructions block in every prompt.
			await field.fill('')
			await page.getByRole('button', { name: 'Save instructions' }).click()
			await expect
				.poll(
					async () => {
						const [row] = await sql<{ instructions: string | null }[]>`
							select instructions from projects where id = ${project.id}
						`
						return row?.instructions ?? null
					},
					{ timeout: 20_000 },
				)
				.toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
