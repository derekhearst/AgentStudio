import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'

/**
 * Wave 5 #19 phase 5 — GitHub webhook helpers.
 *
 * Pure-helper invariants for HMAC verification + event field mapping. The route handler
 * itself is exercised end-to-end when GitHub fires real deliveries; here we pin the
 * structural contracts so regressions on signature checking or status decoding fail fast
 * without needing a live webhook.
 */

function sign(rawBody: string, secret: string): string {
	return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}

test.describe('source-control/github-webhook — verifyWebhookSignature', () => {
	test('accepts a correctly-signed payload', async () => {
		const { verifyWebhookSignature } = await import('../src/lib/source-control/github-webhook')
		const body = '{"hello":"world"}'
		const secret = 'sekret'
		expect(verifyWebhookSignature(body, sign(body, secret), secret)).toBe(true)
	})

	test('rejects when the signature is computed with a different secret', async () => {
		const { verifyWebhookSignature } = await import('../src/lib/source-control/github-webhook')
		const body = '{"hello":"world"}'
		expect(verifyWebhookSignature(body, sign(body, 'wrong-secret'), 'real-secret')).toBe(false)
	})

	test('rejects when the body has been tampered with', async () => {
		const { verifyWebhookSignature } = await import('../src/lib/source-control/github-webhook')
		const sig = sign('{"hello":"world"}', 'sekret')
		expect(verifyWebhookSignature('{"hello":"WORLD"}', sig, 'sekret')).toBe(false)
	})

	test('rejects on missing or malformed signature header', async () => {
		const { verifyWebhookSignature } = await import('../src/lib/source-control/github-webhook')
		expect(verifyWebhookSignature('body', null, 'sekret')).toBe(false)
		expect(verifyWebhookSignature('body', '', 'sekret')).toBe(false)
		expect(verifyWebhookSignature('body', 'sha1=abc', 'sekret')).toBe(false)
		expect(verifyWebhookSignature('body', 'sha256=', 'sekret')).toBe(false)
	})

	test('rejects when the secret is empty (operator hasn\'t configured)', async () => {
		const { verifyWebhookSignature } = await import('../src/lib/source-control/github-webhook')
		expect(verifyWebhookSignature('body', sign('body', ''), '')).toBe(false)
	})
})

test.describe('source-control/github-webhook — mapPullRequestStatus', () => {
	test('opened/reopened map to draft or open based on the draft flag', async () => {
		const { mapPullRequestStatus } = await import('../src/lib/source-control/github-webhook')
		expect(mapPullRequestStatus('opened', false, false)).toBe('open')
		expect(mapPullRequestStatus('opened', false, true)).toBe('draft')
		expect(mapPullRequestStatus('reopened', false, false)).toBe('open')
		expect(mapPullRequestStatus('reopened', false, true)).toBe('draft')
	})

	test('closed maps to merged when the PR was actually merged, else to closed', async () => {
		const { mapPullRequestStatus } = await import('../src/lib/source-control/github-webhook')
		expect(mapPullRequestStatus('closed', true, false)).toBe('merged')
		expect(mapPullRequestStatus('closed', false, false)).toBe('closed')
	})

	test('converted_to_draft / ready_for_review flip status', async () => {
		const { mapPullRequestStatus } = await import('../src/lib/source-control/github-webhook')
		expect(mapPullRequestStatus('converted_to_draft', false, true)).toBe('draft')
		expect(mapPullRequestStatus('ready_for_review', false, false)).toBe('open')
	})

	test('status-irrelevant actions return null so the row\'s status stays untouched', async () => {
		const { mapPullRequestStatus } = await import('../src/lib/source-control/github-webhook')
		expect(mapPullRequestStatus('edited', false, false)).toBeNull()
		expect(mapPullRequestStatus('synchronize', false, false)).toBeNull()
		expect(mapPullRequestStatus('labeled', false, false)).toBeNull()
		expect(mapPullRequestStatus('mystery_action', false, false)).toBeNull()
	})
})

test.describe('source-control/github-webhook — mapCheckRunStatus', () => {
	test('completed runs decode by conclusion', async () => {
		const { mapCheckRunStatus } = await import('../src/lib/source-control/github-webhook')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'success' })).toBe('success')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'neutral' })).toBe('success')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'failure' })).toBe('failure')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'timed_out' })).toBe('failure')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'action_required' })).toBe('failure')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'cancelled' })).toBe('canceled')
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'skipped' })).toBe('skipped')
		// Unknown conclusion → fail closed (operator notices, doesn't quietly pass).
		expect(mapCheckRunStatus({ status: 'completed', conclusion: 'mystery' })).toBe('failure')
	})

	test('mid-flight statuses ignore conclusion', async () => {
		const { mapCheckRunStatus } = await import('../src/lib/source-control/github-webhook')
		expect(mapCheckRunStatus({ status: 'queued', conclusion: null })).toBe('pending')
		expect(mapCheckRunStatus({ status: 'in_progress', conclusion: null })).toBe('running')
		expect(mapCheckRunStatus({ status: 'unknown_status', conclusion: null })).toBe('pending')
	})
})

test.describe('source-control/github-webhook — extractPullRequestEventFields', () => {
	test('extracts the documented fields from a well-formed payload', async () => {
		const { extractPullRequestEventFields } = await import('../src/lib/source-control/github-webhook')
		const payload = {
			action: 'closed',
			repository: { name: 'widgets', owner: { login: 'acme' } },
			pull_request: {
				number: 42,
				title: 'feat: cool thing',
				body: 'A body',
				html_url: 'https://github.com/acme/widgets/pull/42',
				merged: true,
				draft: false,
				merged_at: '2026-05-04T12:00:00Z',
				closed_at: '2026-05-04T12:00:00Z',
				head: { ref: 'feature/cool' },
				base: { ref: 'main' },
			},
		}
		expect(extractPullRequestEventFields(payload)).toEqual({
			action: 'closed',
			owner: 'acme',
			repo: 'widgets',
			prNumber: 42,
			title: 'feat: cool thing',
			body: 'A body',
			htmlUrl: 'https://github.com/acme/widgets/pull/42',
			merged: true,
			draft: false,
			mergedAt: '2026-05-04T12:00:00Z',
			closedAt: '2026-05-04T12:00:00Z',
			headBranch: 'feature/cool',
			baseBranch: 'main',
		})
	})

	test('returns null for a malformed payload (missing pull_request)', async () => {
		const { extractPullRequestEventFields } = await import('../src/lib/source-control/github-webhook')
		expect(extractPullRequestEventFields({ action: 'opened', repository: { name: 'r', owner: { login: 'o' } } })).toBeNull()
		expect(extractPullRequestEventFields(null)).toBeNull()
		expect(extractPullRequestEventFields('not an object')).toBeNull()
	})
})

test.describe('source-control/github-webhook — extractCheckRunEventFields', () => {
	test('decodes a check_run event with multiple PR attachments', async () => {
		const { extractCheckRunEventFields } = await import('../src/lib/source-control/github-webhook')
		const out = extractCheckRunEventFields({
			action: 'completed',
			repository: { name: 'widgets', owner: { login: 'acme' } },
			check_run: {
				name: 'CI / build',
				status: 'completed',
				conclusion: 'failure',
				details_url: 'https://github.com/acme/widgets/actions/runs/1',
				started_at: '2026-05-04T12:00:00Z',
				completed_at: '2026-05-04T12:05:00Z',
				pull_requests: [{ number: 42 }, { number: 43 }],
			},
		})
		expect(out).toEqual({
			action: 'completed',
			owner: 'acme',
			repo: 'widgets',
			checkName: 'CI / build',
			status: 'failure',
			detailsUrl: 'https://github.com/acme/widgets/actions/runs/1',
			startedAt: '2026-05-04T12:00:00Z',
			finishedAt: '2026-05-04T12:05:00Z',
			prNumbers: [42, 43],
		})
	})

	test('returns null when the payload has no check_run object', async () => {
		const { extractCheckRunEventFields } = await import('../src/lib/source-control/github-webhook')
		expect(extractCheckRunEventFields({ action: 'completed', repository: { name: 'r', owner: { login: 'o' } } })).toBeNull()
	})
})
