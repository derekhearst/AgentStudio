import { expect, test } from '@playwright/test'
import {
	OWN_MCP_SERVER,
	isExternalToolName,
	parseToolNamespace,
	resolveToolGate,
	stripToolNamespace,
	toolCapabilities,
} from '../src/lib/engine/permission-mode'

/**
 * Tools served by an MCP server that is not ours (#17).
 *
 * Pure-function tests: `permission-mode.ts` has no DB and no SvelteKit, so this runs
 * without Postgres or a dev server.
 *
 * The rule being pinned: **a tool name is not evidence about what a tool does.** An MCP
 * server chooses its own namespace and its own tool names, so a third party can publish
 * anything it likes — including a name identical to one of ours. Before this, the gate
 * stripped *any* `mcp__*__` namespace and matched what was left against rules written to
 * describe tools we wrote, so `mcp__anything__file_read` classified as read-only and plan
 * mode let it run.
 *
 * Nothing external is configurable yet — the table and the settings UI are the other half
 * of #17. These tests exist so that half cannot land on a gate that fails open.
 */

test.describe('a name from another server is not evidence', () => {
	test('an external tool cannot inherit a read classification by copying a name', () => {
		// The impersonation case, and the reason this change exists.
		const caps = toolCapabilities('mcp__somebodyelse__file_read')

		expect(caps.has('read')).toBe(false)
		expect(caps.has('external')).toBe(true)
		// `mutate` rides along so every mode that fails closed on an unclassified tool
		// keeps failing closed on this one.
		expect(caps.has('mutate')).toBe(true)
	})

	test('nor a write-file classification, which acceptEdits would auto-approve', () => {
		const caps = toolCapabilities('mcp__somebodyelse__file_write')

		expect(caps.has('write-file')).toBe(false)
		expect(
			resolveToolGate({
				mode: 'acceptEdits',
				toolName: 'mcp__somebodyelse__file_write',
				settingsRequiresApproval: false,
			}).gate,
		).toBe('ask')
	})

	test('plan mode refuses it rather than treating it as a read', () => {
		expect(
			resolveToolGate({
				mode: 'plan',
				toolName: 'mcp__somebodyelse__file_read',
				settingsRequiresApproval: false,
			}).gate,
		).toBe('deny')
	})
})

test.describe('the default for a tool we did not write', () => {
	test('is ask, even with no approval setting for it', () => {
		// The operator cannot list what they have never seen — the settings UI enumerates our
		// own registry — so falling through to the settings gate meant "run it".
		const decision = resolveToolGate({
			mode: 'default',
			toolName: 'mcp__linear__create_issue',
			settingsRequiresApproval: false,
		})

		expect(decision.gate).toBe('ask')
		expect(decision.reason).toContain('MCP server you connected')
	})

	test('bypassPermissions still bypasses, because that is what it is for', () => {
		// Documented rather than incidental: bypass is already refused outside an interactive
		// chat run by `resolveEffectivePermissionMode`.
		expect(
			resolveToolGate({
				mode: 'bypassPermissions',
				toolName: 'mcp__linear__create_issue',
				settingsRequiresApproval: false,
			}).gate,
		).toBe('allow')
	})
})

test.describe('our own tools are unaffected', () => {
	test('our namespace still classifies normally', () => {
		expect(isExternalToolName(`mcp__${OWN_MCP_SERVER}__file_read`)).toBe(false)
		expect(toolCapabilities(`mcp__${OWN_MCP_SERVER}__file_read`).has('read')).toBe(true)
		expect(toolCapabilities(`mcp__${OWN_MCP_SERVER}__push_branch`).has('mandatory-approval')).toBe(
			true,
		)
	})

	test('an unqualified built-in is not external', () => {
		expect(isExternalToolName('Write')).toBe(false)
		expect(toolCapabilities('Write').has('write-file')).toBe(true)
		expect(toolCapabilities('Read').has('read')).toBe(true)
	})

	test('stripToolNamespace strips ours and leaves everyone else qualified', () => {
		expect(stripToolNamespace('Write')).toBe('Write')
		expect(stripToolNamespace(`mcp__${OWN_MCP_SERVER}__Write`)).toBe('Write')
		// Left whole on purpose: reducing it to `file_read` is what caused the misclassification.
		expect(stripToolNamespace('mcp__somebodyelse__file_read')).toBe('mcp__somebodyelse__file_read')
	})

	test('namespace parsing handles underscores in a server name', () => {
		// MCP server names routinely contain underscores, and the old regex was fragile here.
		expect(parseToolNamespace('mcp__my_server__do_thing')).toEqual({
			server: 'my_server',
			bare: 'do_thing',
		})
		expect(parseToolNamespace('Write')).toEqual({ server: null, bare: 'Write' })
	})
})
