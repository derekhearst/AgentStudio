import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { error } from '@sveltejs/kit'
import * as devalue from 'devalue'
import { authenticateContext, getActiveUserId, getSql, uniquePrefix } from './helpers'
import { listRemoteFunctions } from './remote-functions'
import { describeFixRunJob, mayFixPullRequest } from '../src/lib/source-control/pr-fix'
import { findPullRequestForFix } from '../src/lib/source-control/pr-fix.server'
import { remoteErrorMessage } from '../src/lib/ui/remote-error'

/**
 * #20 follow-up — "Fix it" checks the pull request is yours before it queues anything, and
 * says what actually happened.
 *
 * Each review item gets exactly one `pr_fix` job, forever: the dedupe key is the item id.
 * Ownership was only checked inside the job, so a press by someone who did not own the pull
 * request still queued — a job that could only fail, holding the item's one slot. The owner's
 * own press then got that failed job back, and the button, which ignored the returned status,
 * announced "Fix run queued" for a run that was never going to happen.
 */

test.describe('source-control/pr-fix — the rules', () => {
	test('a pull request is fixable by its repository’s owner, or by anyone if it has none', () => {
		const owner = randomUUID()
		expect(mayFixPullRequest(owner, owner)).toBe(true)
		expect(mayFixPullRequest(owner, randomUUID())).toBe(false)
		// Repositories from before per-user ownership: the job has always accepted these.
		expect(mayFixPullRequest(null, owner)).toBe(true)
	})

	test('the message follows the job the press came back with', () => {
		const jobId = '0123456789abcdef'
		for (const status of ['pending', 'leased', 'running', 'retry_wait']) {
			expect(describeFixRunJob({ jobId, status })).toMatch(/^Fix run queued \(job 01234567\)/)
		}
		expect(describeFixRunJob({ jobId, status: 'completed' })).toMatch(/already finished/)
		for (const status of ['failed', 'canceled']) {
			const message = describeFixRunJob({ jobId, status })
			expect(message).toContain(`ended as ${status}`)
			expect(message).not.toMatch(/queued/i)
		}
	})
})

test.describe('source-control/pr-fix — ownership is asked before the job exists', () => {
	test('findPullRequestForFix finds your pull request and nobody else’s', async () => {
		const prefix = uniquePrefix('pr-fix-owner').replaceAll(':', '-')
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const [repo] = await sql<{ id: string }[]>`
				insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
				values (${userId}, 'github', ${`${prefix}-owner`}, ${`${prefix}-repo`}, 'https://example.com/r.git', 'main', '{}'::jsonb)
				returning id
			`
			const [pr] = await sql<{ id: string }[]>`
				insert into pull_requests (repository_id, provider_pr_number, title, head_branch, base_branch, status)
				values (${repo.id}, 1, ${`${prefix} PR`}, 'feature', 'main', 'open')
				returning id
			`
			expect(await findPullRequestForFix(userId, pr.id)).toEqual({ id: pr.id })
			// One owner in the users table, so "someone else" is an id that is not theirs.
			expect(await findPullRequestForFix(randomUUID(), pr.id)).toBeNull()
			expect(await findPullRequestForFix(userId, randomUUID())).toBeNull()
		} finally {
			await sql`delete from repositories where owner = ${`${prefix}-owner`}`
		}
	})

	test('a refused press queues nothing, so it cannot take the item’s one fix run', async ({ page, baseURL }) => {
		const sql = getSql()
		const reviewItemId = randomUUID()
		const command = listRemoteFunctions().find(
			(fn) => fn.file === 'src/lib/source-control/source-control.remote.ts' && fn.name === 'startPullRequestFixCommand',
		)!

		await authenticateContext(page.context())
		// The dev server compiles a remote file when a page that imports it is first rendered.
		await page.goto('/review')

		const payload = Buffer.from(
			devalue.stringify({ pullRequestId: randomUUID(), checkName: null, reviewItemId }),
		).toString('base64url')
		const response = await page.request.post(`/_app/remote/${command.id}`, {
			headers: { origin: baseURL!, 'content-type': 'application/json', 'x-sveltekit-pathname': '/review' },
			data: JSON.stringify({ payload, refreshes: [] }),
		})
		expect(response.status()).toBe(200)
		const body = (await response.json()) as { type: string; status?: number; error?: { message?: string } }
		expect(body).toMatchObject({ type: 'error', status: 404, error: { message: 'Pull request not found' } })

		expect(await sql`select id from jobs where type = 'pr_fix' and dedupe_key = ${`pr_fix:item:${reviewItemId}`}`).toHaveLength(0)
	})
})

test.describe('source-control/pr-fix — the button says what the server said', () => {
	test('a refusal shows its own message, not the generic fallback', () => {
		// A remote call rejects with SvelteKit's HttpError, which is not an Error, so the old
		// `e instanceof Error ? e.message : fallback` showed "Failed to queue the fix run" for
		// the 404 above. `remoteErrorMessage` reads the message the server chose.
		let refusal: unknown
		try {
			error(404, 'Pull request not found')
		} catch (err) {
			refusal = err
		}
		expect(refusal instanceof Error).toBe(false)
		expect(remoteErrorMessage(refusal, 'Failed to queue the fix run')).toBe('Pull request not found')
		expect(remoteErrorMessage(new Error('Network down'), 'fallback')).toBe('Network down')
		expect(remoteErrorMessage('???', 'fallback')).toBe('fallback')

		const inbox = readFileSync(join(process.cwd(), 'src/routes/review/_components/InboxList.svelte'), 'utf8')
		expect(inbox).toContain("alert(remoteErrorMessage(e, 'Failed to queue the fix run'))")
		expect(inbox).toContain("alert(remoteErrorMessage(e, 'Failed to resolve'))")
		expect(inbox).not.toMatch(/e instanceof Error \? e\.message/)
	})
})
