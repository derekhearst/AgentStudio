import { expect, test } from '@playwright/test'
import { getFriendlyToolLabel } from '../src/lib/chat/chat'

/**
 * #17 — how a connector's tool call is named on its card (`getFriendlyToolLabel`).
 *
 * Pure: no database and no server, so this runs anywhere.
 *
 * A connector's tool arrives as `mcp__<server>__<tool>`. The card labels it by the tool's own
 * name and says which connector it came from. It must never borrow the copy written for one of
 * our tools: a connector's server can publish a tool under any name it likes, including one of
 * ours, and the card is not the place to lend it our description.
 */

const STATUSES = ['pending', 'approved', 'executing', 'completed', 'failed', 'denied'] as const

test.describe('a connector’s tool on its card', () => {
	test('names the tool and the connector, in every status', () => {
		expect(getFriendlyToolLabel('mcp__github__create_issue', {}, 'pending')).toBe('Create Issue in progress · github')
		expect(getFriendlyToolLabel('mcp__github__create_issue', {}, 'executing')).toBe('Create Issue in progress · github')
		expect(getFriendlyToolLabel('mcp__github__create_issue', {}, 'completed')).toBe('Completed create issue · github')
		expect(getFriendlyToolLabel('mcp__github__create_issue', {}, 'failed')).toBe('Create Issue failed · github')
		expect(getFriendlyToolLabel('mcp__github__create_issue', {}, 'denied')).toBe('Create Issue was denied · github')
		for (const status of STATUSES) {
			const label = getFriendlyToolLabel('mcp__github__create_issue', {}, status)
			expect(label, status).not.toMatch(/mcp/i)
			expect(label.endsWith(' · github'), status).toBe(true)
		}
	})

	test('never borrows the copy written for one of our tools', () => {
		// `Read` has its own copy ("Read a file: …"). A connector publishing a tool called Read
		// gets a plain label with its connector, not ours.
		const theirs = getFriendlyToolLabel('mcp__intruder__Read', { file_path: 'a.ts' }, 'completed')
		const ours = getFriendlyToolLabel('Read', { file_path: 'a.ts' }, 'completed')
		expect(theirs).toBe('Completed read · intruder')
		expect(theirs).not.toBe(ours)
	})

	test('our own tools and the built-ins keep their labels', () => {
		expect(getFriendlyToolLabel('Read', { file_path: 'a.ts' }, 'completed')).not.toMatch(/·/)
		expect(getFriendlyToolLabel('file_read', {}, 'completed')).not.toMatch(/·/)
	})
})
