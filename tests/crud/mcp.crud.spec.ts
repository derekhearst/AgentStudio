import { expect, test } from '@playwright/test'
import {
	answerConfirmDialog,
	authenticateContext,
	expectNoHorizontalOverflow,
	getSql,
	pollDb,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * /settings/connectors CRUD lifecycle (#17), on both projects.
 *
 * Driven through the page against the real server and database: add a connector with a bearer
 * token and a header, switch it off, see a switch whose save fails spring back, run the
 * connection test, edit its label without
 * re-entering the secrets, set two tools' policies, remove it. Every step checks the table as
 * well as the page.
 *
 * The connector points at `connector.invalid`, a name reserved never to resolve, so the Test
 * button's failure is deterministic and nothing is ever reached. It is switched off straight
 * after it is created: an enabled row joins every chat run of the (single) user, and other specs
 * run chats in parallel with this one.
 *
 * The tool list only exists after a successful test, which needs a real server; it is written
 * into the row directly, as a test would have left it, and the page is refreshed to read it.
 */

const TOKEN = 'e2e-connector-token-value'
const HEADER_VALUE = 'e2e-connector-header-value'

test.describe('/settings/connectors — CRUD lifecycle', () => {
	test('add → switch off → test → edit keeping secrets → per-tool policy → remove', async ({ page, context }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('crud-mcp')
		const label = `${prefix} Tracker`
		const name = `e2e-${Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'x')}`
		const sql = getSql()
		await authenticateContext(context)

		type Row = {
			id: string
			label: string
			enabled: boolean
			header_names: string[]
			has_bearer_token: boolean
			encrypted_secrets: string | null
			last_test_ok: boolean | null
			tool_policies: Record<string, string>
		}
		let connectorId: string | null = null
		const readRows = () => sql<Row[]>`
			select id, label, enabled, header_names, has_bearer_token, encrypted_secrets, last_test_ok, tool_policies
			from mcp_servers where name = ${name}
		`

		try {
			await withErrorCapture(page, async () => {
				await page.goto('/settings/connectors')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: 'Connectors', exact: true }).first()).toBeVisible()

				// ── Create
				// PageHeader renders its actions twice (desktop and phone); only one is visible.
				await page.getByRole('button', { name: 'Add connector', exact: true }).filter({ visible: true }).first().click()
				const form = page.getByRole('form', { name: 'New connector' })
				await expect(form).toBeVisible()
				await form.getByLabel('Label', { exact: true }).fill(label)
				await form.getByLabel('Name', { exact: true }).fill(name)
				await form.getByLabel('URL', { exact: true }).fill('https://connector.invalid/mcp')
				await form.getByLabel('Bearer token', { exact: true }).fill(TOKEN)
				await form.getByRole('button', { name: 'Add header' }).click()
				await form.getByLabel('Header name', { exact: true }).fill('X-Team')
				await form.getByLabel('Header value', { exact: true }).fill(HEADER_VALUE)
				await expectNoHorizontalOverflow(page)
				await form.getByRole('button', { name: 'Save', exact: true }).click()

				const [created] = await pollDb(readRows, (rows) => rows.length === 1, { description: 'connector inserted' })
				connectorId = created.id
				expect(created.label).toBe(label)
				expect(created.enabled).toBe(true)
				expect(created.header_names).toEqual(['X-Team'])
				expect(created.has_bearer_token).toBe(true)
				// Encrypted, not stored as typed.
				expect(created.encrypted_secrets).toBeTruthy()
				expect(created.encrypted_secrets).not.toContain(TOKEN)
				expect(created.encrypted_secrets).not.toContain(HEADER_VALUE)

				await expect(form).toHaveCount(0)
				const card = page.getByRole('region', { name: `Connector ${label}` })
				await expect(card).toBeVisible()
				await expect(card.getByText(`mcp__${name}__…`)).toBeVisible()
				await expect(card.getByText('Signs in with a bearer token, X-Team')).toBeVisible()
				await expect(card.getByText('Not tested since it was last changed.')).toBeVisible()
				// The page is never handed a secret to show.
				await expect(page.getByText(TOKEN)).toHaveCount(0)
				await expect(page.getByText(HEADER_VALUE)).toHaveCount(0)
				// The title keeps its width beside the switch on a phone.
				const title = await card.getByRole('heading', { name: label }).boundingBox()
				expect(title?.width ?? 0).toBeGreaterThan(40)

				// ── Update: switch it off
				const toggle = card.getByRole('checkbox', { name: `Use ${label} in chats` })
				await expect(toggle).toBeChecked()
				await toggle.click()
				await pollDb(readRows, (rows) => rows[0]?.enabled === false, { description: 'connector switched off' })
				await expect(toggle).not.toBeChecked()
				await expect(card.getByText('Off', { exact: true }).first()).toBeVisible()

				// ── A switch whose save fails goes back to what the server still says
				await page.route('**/_app/remote/**', async (route) => {
					if (new URL(route.request().url()).pathname.endsWith('/setMcpServerEnabledCommand')) {
						await route.fulfill({
							status: 400,
							contentType: 'application/json',
							body: JSON.stringify({ type: 'error', status: 400, error: { message: 'Scripted refusal' } }),
						})
						return
					}
					await route.fallback()
				})
				await toggle.click()
				await expect(page.getByRole('alert').filter({ hasText: 'Scripted refusal' })).toBeVisible()
				await expect(toggle).not.toBeChecked()
				await expect(card.getByText('Off', { exact: true }).first()).toBeVisible()
				await page.unroute('**/_app/remote/**')
				expect((await readRows())[0]?.enabled).toBe(false)

				// ── The connection test: the name never resolves, so it fails, and says so
				await card.getByRole('button', { name: 'Test', exact: true }).click()
				await pollDb(readRows, (rows) => rows[0]?.last_test_ok === false, {
					description: 'failed test recorded',
					timeoutMs: 30_000,
				})
				await expect(card.getByText(/· tested /)).toBeVisible()
				await expect(page.getByRole('alert').filter({ hasText: label })).toBeVisible()

				// ── Update: a new label, secrets left blank — they are kept, and the test result stands
				await card.getByRole('button', { name: 'Edit', exact: true }).click()
				const editForm = page.getByRole('form', { name: `Edit connector ${label}` })
				await expect(editForm).toBeVisible()
				await expect(editForm.getByLabel('Name', { exact: true })).toBeDisabled()
				await expect(editForm.getByLabel('Bearer token', { exact: true })).toHaveValue('')
				await expect(editForm.getByLabel('Header value', { exact: true })).toHaveValue('')
				const renamed = `${label} v2`
				await editForm.getByLabel('Label', { exact: true }).fill(renamed)
				await editForm.getByRole('button', { name: 'Save', exact: true }).click()

				const [edited] = await pollDb(readRows, (rows) => rows[0]?.label === renamed, { description: 'label edited' })
				expect(edited.encrypted_secrets).toBe(created.encrypted_secrets)
				expect(edited.has_bearer_token).toBe(true)
				expect(edited.header_names).toEqual(['X-Team'])
				expect(edited.last_test_ok).toBe(false)
				const renamedCard = page.getByRole('region', { name: `Connector ${renamed}` })
				await expect(renamedCard).toBeVisible()

				// ── Update: per-tool policy, on the tool list a successful test would have left
				await sql`
					update mcp_servers
					set tools_snapshot = ${sql.json([
						{ name: 'search_issues', title: null, description: 'Search issues', readOnly: true, destructive: false, openWorld: null },
						{ name: 'delete_repo', title: null, description: 'Delete a repository', readOnly: false, destructive: true, openWorld: null },
					])},
						last_test_ok = true, last_error = null, last_tested_at = now()
					where id = ${created.id}
				`
				await page.getByRole('button', { name: 'Refresh', exact: true }).filter({ visible: true }).first().click()
				await renamedCard.getByText(/^Tools \(2\)/).click()
				const search = renamedCard.getByRole('group', { name: 'Policy for search_issues' })
				const remove = renamedCard.getByRole('group', { name: 'Policy for delete_repo' })
				await expect(search.getByRole('button', { name: 'Ask', exact: true })).toHaveAttribute('aria-pressed', 'true')
				await expect(renamedCard.getByText('destructive', { exact: true })).toBeVisible()

				await search.getByRole('button', { name: 'Allow', exact: true }).click()
				await pollDb(readRows, (rows) => rows[0]?.tool_policies?.search_issues === 'allow', {
					description: 'search_issues allowed',
				})
				await remove.getByRole('button', { name: 'Block', exact: true }).click()
				const [withPolicy] = await pollDb(readRows, (rows) => rows[0]?.tool_policies?.delete_repo === 'block', {
					description: 'delete_repo blocked',
				})
				expect(withPolicy.tool_policies).toEqual({ search_issues: 'allow', delete_repo: 'block' })
				await expect(search.getByRole('button', { name: 'Allow', exact: true })).toHaveAttribute('aria-pressed', 'true')
				await expect(remove.getByRole('button', { name: 'Block', exact: true })).toHaveAttribute('aria-pressed', 'true')
				await expectNoHorizontalOverflow(page)

				// ── Delete
				await renamedCard.getByRole('button', { name: 'Remove', exact: true }).click()
				await answerConfirmDialog(page, 'Remove')
				await pollDb(readRows, (rows) => rows.length === 0, { description: 'connector deleted' })
				await expect(renamedCard).toHaveCount(0)

				const actions = await sql<{ action: string }[]>`
					select action::text as action from audit_events where target_id = ${created.id} order by created_at asc
				`
				expect(actions[0]?.action).toBe('mcp_server.created')
				expect(actions.at(-1)?.action).toBe('mcp_server.deleted')
				expect(JSON.stringify(actions)).not.toContain(TOKEN)
			})
		} finally {
			const leftover = await sql<{ id: string }[]>`select id from mcp_servers where name = ${name}`
			const ids = [...new Set([...leftover.map((row) => row.id), ...(connectorId ? [connectorId] : [])])]
			if (ids.length > 0) {
				await sql`delete from mcp_servers where id in ${sql(ids)}`
				await sql`delete from audit_events where target_type = 'mcp_server' and target_id in ${sql(ids)}`
			}
		}
	})

	test('Settings links to the connectors page', async ({ page, context }) => {
		await authenticateContext(context)
		await withErrorCapture(page, async () => {
			await page.goto('/settings')
			await page.waitForLoadState('domcontentloaded')
			const link = page.getByRole('link', { name: 'Manage connectors' })
			await link.scrollIntoViewIfNeeded()
			await link.click()
			await expect(page).toHaveURL(/\/settings\/connectors$/)
			await expect(page.getByRole('heading', { name: 'Connectors', exact: true }).first()).toBeVisible()
		})
	})
})
