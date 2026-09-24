import { expect, test } from '@playwright/test'
import {
	MAX_LEDGER_LABEL_CHARS,
	SELF_LOGGED_CALL_TOOLS,
	connectorProvider,
	ledgerLabel,
	toolCallLedgerEntry,
} from '../src/lib/costs/tool-call-ledger'

/**
 * What a completed tool call contributes to the usage ledger.
 *
 * Pure-function tests: `src/lib/costs/tool-call-ledger.ts` has no DB and no SvelteKit, so
 * this spec runs without Postgres or a dev server (same arrangement as
 * `automations.cron.spec.ts`).
 *
 * What is pinned here is mostly about not corrupting the one number allowed to block a run:
 *   - every row costs zero. These calls run locally; their real price is tokens, accounted
 *     per run. Budget limits sum `cost`, so an invented price here would be able to stop
 *     work that should have been allowed
 *   - failures are still counted, or the busiest sessions look the quietest
 *   - `web_search` is skipped because it already writes its own `call` row
 */

test('built-in calls are counted, at zero cost', () => {
	const entry = toolCallLedgerEntry({ name: 'Edit', success: true })

	expect(entry?.toolName).toBe('Edit')
	expect(entry?.unitType).toBe('call')
	expect(entry?.units).toBe(1)
	// Not a price. Budget enforcement sums this column.
	expect(entry?.cost).toBe(0)
})

test('a failed call still counts', () => {
	const entry = toolCallLedgerEntry({ name: 'Bash', success: false })

	expect(entry).not.toBeNull()
	expect(entry?.metadata.success).toBe(false)
})

test('web_search is skipped — it writes its own call row', () => {
	// Double-counting calls would make the one tool that always logged look twice as busy
	// as the ones that never did.
	expect(SELF_LOGGED_CALL_TOOLS.has('web_search')).toBe(true)
	expect(toolCallLedgerEntry({ name: 'web_search', success: true })).toBeNull()
})

test('the media generators are NOT skipped', () => {
	// They log in credit/second units and only when a generation cost money, so a call row
	// alongside counts the call without double-counting the spend.
	expect(toolCallLedgerEntry({ name: 'image_generate', success: true })).not.toBeNull()
	expect(toolCallLedgerEntry({ name: 'video_generate', success: true })).not.toBeNull()
})

test.describe('labels, from the typed result', () => {
	test('an edit records which file', () => {
		const entry = toolCallLedgerEntry({
			name: 'Edit',
			success: true,
			details: {
				kind: 'file_edit',
				tool: 'Edit',
				path: '/w/src/app.ts',
				changeType: 'update',
				hunks: [],
				additions: 1,
				deletions: 0,
				unavailable: 'none',
				truncated: false,
			},
		})

		expect(entry?.metadata.label).toBe('/w/src/app.ts')
	})

	test('a shell call records which command', () => {
		const entry = toolCallLedgerEntry({
			name: 'Bash',
			success: true,
			details: {
				kind: 'shell',
				tool: 'Bash',
				command: 'bun run check',
				description: null,
				stdout: '',
				stderr: '',
				interrupted: false,
				backgroundTaskId: null,
				timedOutAfterMs: null,
				persistedOutputPath: null,
				truncated: false,
			},
		})

		expect(entry?.metadata.label).toBe('bun run check')
	})

	test('a long label is clipped rather than stored whole', () => {
		const label = ledgerLabel({
			kind: 'shell',
			tool: 'Bash',
			command: 'x'.repeat(5000),
			description: null,
			stdout: '',
			stderr: '',
			interrupted: false,
			backgroundTaskId: null,
			timedOutAfterMs: null,
			persistedOutputPath: null,
			truncated: false,
		})

		expect((label?.length ?? 0) <= MAX_LEDGER_LABEL_CHARS + 1).toBe(true)
	})

	test('no typed result means no label, but still a counted call', () => {
		const entry = toolCallLedgerEntry({ name: 'Glob', success: true })

		expect(entry).not.toBeNull()
		expect(entry?.metadata.label).toBe(undefined)
		expect(ledgerLabel(undefined)).toBeNull()
	})
})

test.describe('a connector’s tool (#17)', () => {
	test('is counted under its full name, with the connector as the provider', () => {
		// The provider column lets usage be grouped by the connector that served the call.
		const entry = toolCallLedgerEntry({ name: 'mcp__github__create_issue', success: true })

		expect(entry?.toolName).toBe('mcp__github__create_issue')
		expect(entry?.provider).toBe('mcp:github')
		expect(entry?.cost).toBe(0)
	})

	test('ours and the built-ins carry no provider', () => {
		expect(connectorProvider('mcp__agentstudio__file_read')).toBeNull()
		expect(connectorProvider('Edit')).toBeNull()
		expect(toolCallLedgerEntry({ name: 'Edit', success: true })).not.toHaveProperty('provider')
	})

	test('the provider is the connector’s key, split where the CLI splits the name', () => {
		expect(connectorProvider('mcp__my-tracker__list__items')).toBe('mcp:my-tracker')
	})
})
