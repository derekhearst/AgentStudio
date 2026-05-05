import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	getSql,
	pollDb,
	seedAgent,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * Agents CRUD lifecycle covering /agents, /agents/[id], /agents/[id]/identity.
 *
 * Agent creation via /agents/new is a guided LLM chat (covered separately by
 * chat specs). This spec seeds an agent via SQL and exercises the rest:
 *   - List visibility
 *   - Detail page renders
 *   - Update systemPrompt + model via the inline editor
 *   - Promote identity to a paired skill (/agents/[id]/identity)
 *   - Edit identity content + assert skill row updates
 *   - Unlink identity + assert agent.identity_skill_id is cleared
 */

test.describe('/agents — CRUD lifecycle (excluding LLM-driven create)', () => {
	test('list → detail → update systemPrompt → promote identity → edit identity → unlink', async ({
		page,
		context,
	}) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('crud-agents')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()

		const seed = await seedAgent(prefix, { name: `${prefix} Agent`, role: `${prefix} role` })

		try {
			await withErrorCapture(page, async () => {
				// ── Read /agents list
				await page.goto('/agents')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByText(seed.name).first()).toBeVisible({ timeout: 8_000 })

				// ── Read /agents/[id]
				await page.goto(`/agents/${seed.id}`)
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: seed.name }).first()).toBeVisible()

				// ── Update systemPrompt via inline editor (Agent configuration panel)
				const newPrompt = `${prefix} updated system prompt content`
				// The "Agent configuration" header has the Edit button. Find by header text.
				const configHeader = page
					.locator('h2', { hasText: 'Agent configuration' })
					.locator('xpath=ancestor::*[1]')
				await configHeader.getByRole('button', { name: 'Edit', exact: true }).click()
				const promptTextarea = page.locator('textarea.textarea-bordered.min-h-52')
				await expect(promptTextarea).toBeVisible({ timeout: 5_000 })
				await promptTextarea.fill(newPrompt)
				// The Save button replaces Edit in the same container after entering edit mode.
				await configHeader.getByRole('button', { name: /^Save/ }).click()
				await pollDb(
					() => sql<{ system_prompt: string }[]>`select system_prompt from agents where id = ${seed.id}`,
					(rows) => rows[0]?.system_prompt === newPrompt,
					{ description: 'agent systemPrompt updated' },
				)

				// ── Promote identity to a paired skill
				await page.goto(`/agents/${seed.id}/identity`)
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: /Identity/ })).toBeVisible()
				await page.getByRole('button', { name: 'Promote to skill' }).click()
				const linkRow = await pollDb(
					() => sql<{ identity_skill_id: string | null }[]>`
						select identity_skill_id from agents where id = ${seed.id}
					`,
					(rows) => rows[0]?.identity_skill_id !== null,
					{ description: 'identity skill linked to agent' },
				)
				const skillId = linkRow[0].identity_skill_id

				// ── Update identity skill content
				const identityContent = `${prefix} new identity content`
				const identityTextarea = page.locator('textarea.textarea-bordered.font-mono')
				await identityTextarea.fill(identityContent)
				await page.getByRole('button', { name: 'Save', exact: true }).first().click()
				await pollDb(
					() => sql<{ content: string }[]>`select content from skills where id = ${skillId}`,
					(rows) => rows[0]?.content === identityContent,
					{ description: 'identity skill content updated' },
				)

				// ── Unlink identity (button asks confirm)
				page.on('dialog', (d) => void d.accept())
				await page.getByRole('button', { name: 'Unlink skill' }).click()
				await pollDb(
					() => sql<{ identity_skill_id: string | null }[]>`
						select identity_skill_id from agents where id = ${seed.id}
					`,
					(rows) => rows[0]?.identity_skill_id === null,
					{ description: 'identity skill unlinked' },
				)

				// ── Layout
				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
