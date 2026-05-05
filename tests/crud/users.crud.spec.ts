import { expect, test } from '@playwright/test'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	expectNoHorizontalOverflow,
	getSql,
	pollDb,
	uniquePrefix,
	withErrorCapture,
} from '../helpers'

/**
 * /users CRUD lifecycle — admin user management.
 *
 * Covers create + promote + demote + soft-delete + restore. All operations are
 * gated to admin in the remote functions; the helper authenticates as the
 * seeded admin so every action goes through the real permission layer.
 *
 * Audit-event invariants: each mutation should write a row to `audit_events`
 * (settings.updated, user.created, user.role.changed, user.deactivated). We
 * assert at least the create + role-change + deactivate ones since those are
 * the wired wrappers.
 */

test.describe('/users — admin CRUD lifecycle', () => {
	test('create → promote → demote → soft-delete → restore', async ({ page, context }) => {
		const prefix = uniquePrefix('crud-users')
		await cleanupExtendedPrefix(prefix)
		await authenticateContext(context)
		const sql = getSql()
		// Username regex on createUser is ^[a-zA-Z0-9_-]{3,32}$ — keep it short.
		const usernameSuffix = prefix
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '')
			.slice(-12)
		const username = `e2e_${usernameSuffix}_u`

		try {
			await withErrorCapture(page, async () => {
				// ── Read: load the users page
				await page.goto('/users')
				await page.waitForLoadState('domcontentloaded')
				await expect(page.getByRole('heading', { name: 'User management' })).toBeVisible()

				// ── Create: click "Add account" + fill the modal
				await page.getByRole('button', { name: 'Add account' }).click()
				// Scope inside the modal-box (DaisyUI modal). The <dialog> doesn't behave as
				// "visible" in Playwright when opened non-modally; reach inside its modal-box
				// instead, and wait for the heading inside the box to appear.
				const dialog = page.locator('.modal-box').filter({ has: page.getByRole('heading', { name: 'Create account' }) })
				await expect(dialog).toBeVisible({ timeout: 5_000 })
				// Locate fields by their preceding label-text spans. DaisyUI's <label class="form-control">
				// pattern wraps the span + input but doesn't htmlFor, so getByLabel doesn't match.
				const usernameInput = dialog
					.locator('label.form-control')
					.filter({ has: page.getByText('Username', { exact: true }) })
					.locator('input')
				const nameInput = dialog
					.locator('label.form-control')
					.filter({ has: page.getByText('Display name', { exact: true }) })
					.locator('input')
				await usernameInput.fill(username)
				await nameInput.fill(`${prefix} display`.slice(0, 60))
				await dialog.getByRole('button', { name: 'Create' }).click()

				// Wait for the modal to close (showCreate=false after createUser resolves).
				await expect(dialog).toBeHidden({ timeout: 5_000 })

				// DB invariant first: row exists with role=user, is_active=true
				await pollDb(
					() => sql<{ role: string; is_active: boolean }[]>`
						select role, is_active from users where username = ${username}
					`,
					(rows) => rows[0]?.role === 'user' && rows[0]?.is_active === true,
					{ description: 'user created with role=user' },
				)

				// Reload so the page picks up the fresh user list (loadUsers in onCreate
				// can race against Playwright's read in dev mode).
				await page.reload()
				await page.waitForLoadState('domcontentloaded')

				// Read back: row appears with username
				const newRow = page.locator('tr').filter({ hasText: username })
				await expect(newRow).toBeVisible({ timeout: 8_000 })

				// Audit invariant: user.created event fired
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from audit_events
						where action = 'user.created'::audit_action and target_type = 'user'
						  and after_state->>'username' = ${username}
					`,
					(rows) => rows[0]?.count === 1,
					{ description: 'audit_events row for user.created' },
				)

				// Auto-accept every confirm() dialog from now on (promote, demote, remove).
				page.on('dialog', (d) => void d.accept())

				// ── Update (promote): click Promote on the new row
				await newRow.getByRole('button', { name: 'Promote' }).click()
				await pollDb(
					() => sql<{ role: string }[]>`select role from users where username = ${username}`,
					(rows) => rows[0]?.role === 'admin',
					{ description: 'user promoted to admin' },
				)

				// Audit invariant: user.role.changed fired
				const promotionAudit = await sql<{ before_state: { role: string }; after_state: { role: string } }[]>`
					select before_state, after_state from audit_events
					where action = 'user.role.changed'::audit_action
					  and target_id = (select id::text from users where username = ${username})
					order by created_at desc limit 1
				`
				expect(promotionAudit[0]?.before_state.role).toBe('user')
				expect(promotionAudit[0]?.after_state.role).toBe('admin')

				// ── Update (demote): page may need a reload for Svelte to refresh derived state
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const refreshedRow = page.locator('tr').filter({ hasText: username })
				await refreshedRow.getByRole('button', { name: 'Demote' }).click()
				await pollDb(
					() => sql<{ role: string }[]>`select role from users where username = ${username}`,
					(rows) => rows[0]?.role === 'user',
					{ description: 'user demoted back to user' },
				)

				// ── Delete (soft): click Remove
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const rowAfterDemote = page.locator('tr').filter({ hasText: username })
				await rowAfterDemote.getByRole('button', { name: 'Remove' }).click()
				await pollDb(
					() => sql<{ is_active: boolean; deleted_at: Date | null }[]>`
						select is_active, deleted_at from users where username = ${username}
					`,
					(rows) => rows[0]?.is_active === false && rows[0]?.deleted_at !== null,
					{ description: 'user soft-deleted (is_active=false + deleted_at set)' },
				)

				// Audit invariant: user.deactivated fired
				await pollDb(
					() => sql<{ count: number }[]>`
						select count(*)::int as count from audit_events
						where action = 'user.deactivated'::audit_action
						  and target_id = (select id::text from users where username = ${username})
					`,
					(rows) => rows[0]?.count === 1,
					{ description: 'audit_events row for user.deactivated' },
				)

				// ── Restore: click Restore on the deleted row
				await page.reload()
				await page.waitForLoadState('domcontentloaded')
				const deletedRow = page.locator('tr').filter({ hasText: username })
				await deletedRow.getByRole('button', { name: 'Restore' }).click()
				await pollDb(
					() => sql<{ is_active: boolean; deleted_at: Date | null }[]>`
						select is_active, deleted_at from users where username = ${username}
					`,
					(rows) => rows[0]?.is_active === true && rows[0]?.deleted_at === null,
					{ description: 'user restored (is_active=true + deleted_at null)' },
				)

				// ── Layout check: nothing overflows the viewport
				await expectNoHorizontalOverflow(page)
			})
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
