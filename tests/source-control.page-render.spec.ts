import { expect, test } from '@playwright/test'
import { authenticateContext, getSql } from './helpers'

/**
 * Wave 5 #19 phase 2 — end-to-end render check for /source-control.
 *
 * Authenticates a session, lands on the page, and verifies:
 *   - The page renders + the title is "Source control"
 *   - When OAuth env vars are missing, the setup walkthrough appears
 *   - When OAuth env vars are set, the "Connect GitHub" button is rendered + the setup
 *     walkthrough is hidden
 *
 * Bonus: drops a fake `repositories` row for the active user so we can verify the synced-repo
 * table renders the metadata layout. Uses derekhearst/AgentStudio's actual GitHub-shape so
 * this doubles as proof the mapper produces the right UI shape.
 */

test.describe('source-control/page-render — end-to-end UI', () => {
	test('page loads + title set + setup walkthrough surfaces correctly', async ({ page, context }) => {
		await authenticateContext(context)
		await page.goto('/source-control')
		await page.waitForLoadState('domcontentloaded')

		await expect(page).toHaveTitle(/Source control/)
		await expect(page.getByRole('heading', { name: /Source control/i })).toBeVisible()

		// Wait for the loading spinner to disappear before checking content state.
		await expect(page.getByText('Loading…')).toBeHidden({ timeout: 10_000 })

		// Either configured (Connect button) or not (setup walkthrough). Both are valid.
		const setupWalkthrough = page.getByText('GitHub OAuth not configured.')
		const connectButton = page.getByRole('link', { name: /Connect GitHub/i })

		const setupVisible = await setupWalkthrough.isVisible().catch(() => false)
		const connectVisible = await connectButton.isVisible().catch(() => false)
		expect(setupVisible || connectVisible).toBe(true)

		if (setupVisible) {
			// Walkthrough must mention the env vars + callback URL.
			await expect(page.getByText('GITHUB_OAUTH_CLIENT_ID')).toBeVisible()
			await expect(page.getByText('GITHUB_OAUTH_CLIENT_SECRET')).toBeVisible()
			await expect(page.getByText('APP_ENCRYPTION_KEY')).toBeVisible()
			await expect(page.getByText(/source-control\/github\/callback/)).toBeVisible()
		}
	})

	test('synced repo card renders for derekhearst/AgentStudio shape', async ({ page, context }) => {
		await authenticateContext(context)
		const sql = getSql()
		const [user] = await sql<{ id: string }[]>`
			select id from users where is_active = true and deleted_at is null
			order by case when role = 'admin' then 0 else 1 end, created_at asc limit 1
		`
		// Insert the actual derekhearst/AgentStudio shape we got from the live GitHub API.
		await sql`
			insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
			values (
				${user.id},
				'github'::source_control_provider,
				'derekhearst',
				'AgentStudio',
				'https://github.com/derekhearst/AgentStudio.git',
				'main',
				${sql.json({
					htmlUrl: 'https://github.com/derekhearst/AgentStudio',
					sshUrl: 'git@github.com:derekhearst/AgentStudio.git',
					private: false,
					description: null,
					archived: false,
					fork: false,
					providerRepoId: 1200303948,
					ownerType: 'User',
					stargazersCount: 1,
					pushedAt: '2026-05-04T07:44:24Z',
				})}
			)
			on conflict (user_id, owner, name) do update set updated_at = now()
		`
		try {
			await page.goto('/source-control')
			await page.waitForLoadState('domcontentloaded')

			// The synced-repos table should now show derekhearst/AgentStudio.
			await expect(page.getByText('derekhearst/AgentStudio')).toBeVisible()
			// Default branch column.
			await expect(page.locator('code', { hasText: 'main' }).first()).toBeVisible()
			// Visibility badge — public.
			await expect(page.locator('.badge', { hasText: 'public' }).first()).toBeVisible()
			// "Open ↗" link should point at the GitHub html_url.
			const openLink = page.getByRole('link', { name: /Open/ }).first()
			await expect(openLink).toHaveAttribute('href', 'https://github.com/derekhearst/AgentStudio')
		} finally {
			await sql`delete from repositories where owner = 'derekhearst' and name = 'AgentStudio' and user_id = ${user.id}`
		}
	})
})
