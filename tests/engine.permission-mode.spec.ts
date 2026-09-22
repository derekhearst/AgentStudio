import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import {
	PERMISSION_MODES,
	PERMISSION_MODE_LABELS,
	isMandatoryApprovalTool,
	isPermissionMode,
	normalizePermissionMode,
	requiresExplicitConfirm,
	resolveEffectivePermissionMode,
	resolveToolGate,
	sdkPermissionModeFor,
	stripToolNamespace,
	toolCapabilities,
	type ConversationPermissionMode,
} from '../src/lib/engine/permission-mode'

/**
 * Issue #19 — per-conversation permission mode, pure half.
 *
 * `src/lib/engine/permission-mode.ts` has no DB, no SvelteKit and no `$lib` imports, so this
 * spec runs without Postgres or a dev server (same arrangement as `monitors.condition.spec.ts`
 * and `aaak.unit.spec.ts`).
 *
 * The headline assertion — the one that must never regress — is the first describe block:
 * the mandatory-approval tools stay gated in EVERY mode, `bypassPermissions` included, for
 * every value of the per-tool approval settings.
 */

const MANDATORY_TOOLS = ['push_branch', 'create_pull_request', 'request_plan_approval'] as const

const ALL_MODES: readonly ConversationPermissionMode[] = PERMISSION_MODES

// ─────────── THE INVARIANT ───────────

test.describe('permission-mode — mandatory approval survives every mode', () => {
	for (const mode of ALL_MODES) {
		for (const tool of MANDATORY_TOOLS) {
			for (const settingsRequiresApproval of [true, false]) {
				test(`${tool} is gated in ${mode} (settings say ${settingsRequiresApproval})`, () => {
					const decision = resolveToolGate({ mode, toolName: tool, settingsRequiresApproval })
					expect(decision.gate).toBe('ask')
					expect(decision.reason).toBeTruthy()
				})
			}
		}
	}

	test('the MCP-qualified name is gated too — the gate strips the namespace', () => {
		for (const tool of MANDATORY_TOOLS) {
			const decision = resolveToolGate({
				mode: 'bypassPermissions',
				toolName: `mcp__agentstudio__${tool}`,
				settingsRequiresApproval: false,
			})
			expect(decision.gate).toBe('ask')
		}
	})

	test('bypassPermissions auto-allows ordinary tools, so the gate above is not vacuous', () => {
		for (const tool of ['Bash', 'Write', 'Read', 'clone_repository', 'run_code']) {
			expect(
				resolveToolGate({ mode: 'bypassPermissions', toolName: tool, settingsRequiresApproval: true })
					.gate,
			).toBe('allow')
		}
	})

	test('MANDATORY_APPROVAL_TOOLS in $lib/tools/tools has not drifted from the capability rules', () => {
		// Read rather than import: `$lib/tools/tools` pulls in js-tiktoken and the logger, which
		// this dependency-free spec deliberately does not load. Drift here is the exact failure
		// mode that would silently un-gate a push, so it is asserted rather than assumed.
		const source = readFileSync(
			fileURLToPath(new URL('../src/lib/tools/tools.ts', import.meta.url)),
			'utf8',
		)
		const block = /MANDATORY_APPROVAL_TOOLS[^=]*=\s*\[([\s\S]*?)\]/.exec(source)
		expect(block, 'MANDATORY_APPROVAL_TOOLS not found in src/lib/tools/tools.ts').toBeTruthy()
		const names = [...block![1].matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1])
		expect(names.length).toBeGreaterThan(0)
		for (const name of names) {
			expect(isMandatoryApprovalTool(name), `${name} must classify as mandatory-approval`).toBe(true)
			for (const mode of ALL_MODES) {
				expect(
					resolveToolGate({ mode, toolName: name, settingsRequiresApproval: false }).gate,
					`${name} must stay gated in ${mode}`,
				).toBe('ask')
			}
		}
	})
})

// ─────────── Mode semantics ───────────

test.describe('permission-mode — default', () => {
	test('defers entirely to the per-tool settings', () => {
		expect(
			resolveToolGate({ mode: 'default', toolName: 'Bash', settingsRequiresApproval: true }).gate,
		).toBe('ask')
		expect(
			resolveToolGate({ mode: 'default', toolName: 'Bash', settingsRequiresApproval: false }).gate,
		).toBe('allow')
		expect(
			resolveToolGate({ mode: 'default', toolName: 'Write', settingsRequiresApproval: true })
				.gate,
		).toBe('ask')
	})
})

test.describe('permission-mode — plan', () => {
	test('refuses every write and every other side effect', () => {
		for (const tool of ['Bash', 'run_code', 'Edit', 'delete_file', 'clone_repository', 'create_project']) {
			const decision = resolveToolGate({ mode: 'plan', toolName: tool, settingsRequiresApproval: false })
			expect(decision.gate, `${tool} must be denied in plan mode`).toBe('deny')
			expect(decision.reason).toContain('Plan mode')
		}
	})

	test('an unknown tool fails closed — plan mode denies what it cannot classify', () => {
		expect(
			resolveToolGate({
				mode: 'plan',
				toolName: 'some_tool_nobody_has_written_yet',
				settingsRequiresApproval: false,
			}).gate,
		).toBe('deny')
	})

	test('read-only tools still run, so the agent can actually investigate', () => {
		for (const tool of ['Read', 'Glob', 'Grep', 'git_diff', 'web_search', 'read_skill']) {
			expect(
				resolveToolGate({ mode: 'plan', toolName: tool, settingsRequiresApproval: false }).gate,
				`${tool} should be readable in plan mode`,
			).toBe('allow')
		}
	})

	test('plan mode and the Plan agent compose: the plan file write is asked for, not refused', () => {
		// The Plan agent writes PLAN.md and hands the path to request_plan_approval (see
		// READ_ONLY_TOOL_NAMES in $lib/agents/builtin-agents.server.ts). Denying Write
		// outright would break that handoff, so plan mode surfaces it for approval instead.
		const write = resolveToolGate({ mode: 'plan', toolName: 'Write', settingsRequiresApproval: false })
		expect(write.gate).toBe('ask')
		const handoff = resolveToolGate({
			mode: 'plan',
			toolName: 'request_plan_approval',
			settingsRequiresApproval: false,
		})
		expect(handoff.gate).toBe('ask')
	})
})

test.describe('permission-mode — acceptEdits', () => {
	test('file edits run without asking', () => {
		for (const tool of ['Write', 'Edit', 'Edit', 'delete_file', 'move_file']) {
			expect(
				resolveToolGate({ mode: 'acceptEdits', toolName: tool, settingsRequiresApproval: true }).gate,
				`${tool} should be auto-approved by acceptEdits`,
			).toBe('allow')
		}
	})

	test('everything else is still gated by the settings', () => {
		expect(
			resolveToolGate({ mode: 'acceptEdits', toolName: 'Bash', settingsRequiresApproval: true }).gate,
		).toBe('ask')
		expect(
			resolveToolGate({ mode: 'acceptEdits', toolName: 'run_code', settingsRequiresApproval: true })
				.gate,
		).toBe('ask')
	})

	test('an unknown tool is not auto-approved', () => {
		expect(
			resolveToolGate({
				mode: 'acceptEdits',
				toolName: 'some_tool_nobody_has_written_yet',
				settingsRequiresApproval: true,
			}).gate,
		).toBe('ask')
	})
})

// ─────────── bypass is refused off the interactive surface ───────────

test.describe('permission-mode — detached / automation runs', () => {
	test('bypassPermissions is refused anywhere but an interactive chat run', () => {
		for (const source of ['agent_subagent', 'automation', null, undefined, 'something_new']) {
			const resolved = resolveEffectivePermissionMode({
				requested: 'bypassPermissions',
				runSource: source,
			})
			expect(resolved.mode, `bypass must not survive a ${source} run`).toBe('default')
			expect(resolved.downgraded).toBe(true)
			expect(resolved.reason).toContain('interactive chat run')
		}
	})

	test('bypassPermissions survives an interactive chat run', () => {
		const resolved = resolveEffectivePermissionMode({
			requested: 'bypassPermissions',
			runSource: 'chat_stream',
		})
		expect(resolved.mode).toBe('bypassPermissions')
		expect(resolved.downgraded).toBe(false)
	})

	test('the other modes pass through on every surface', () => {
		for (const mode of ['default', 'plan', 'acceptEdits'] as const) {
			for (const source of ['chat_stream', 'agent_subagent', 'automation']) {
				const resolved = resolveEffectivePermissionMode({ requested: mode, runSource: source })
				expect(resolved.mode).toBe(mode)
				expect(resolved.downgraded).toBe(false)
			}
		}
	})
})

// ─────────── SDK mapping ───────────

test.describe('permission-mode — SDK mapping', () => {
	test('never hands the SDK bypassPermissions, which would skip canUseTool', () => {
		for (const mode of ALL_MODES) {
			expect(sdkPermissionModeFor(mode)).not.toBe('bypassPermissions')
		}
	})

	test('acceptEdits passes through; bypass and plan are enforced by our own gate', () => {
		expect(sdkPermissionModeFor('acceptEdits')).toBe('acceptEdits')
		expect(sdkPermissionModeFor('default')).toBe('default')
		expect(sdkPermissionModeFor('plan')).toBe('default')
		expect(sdkPermissionModeFor('bypassPermissions')).toBe('default')
	})
})

// ─────────── Parsing, labels, schema agreement ───────────

test.describe('permission-mode — parsing and metadata', () => {
	test('normalizePermissionMode fails closed', () => {
		expect(normalizePermissionMode('bypassPermissions')).toBe('bypassPermissions')
		expect(normalizePermissionMode('BYPASSPERMISSIONS')).toBe('default')
		expect(normalizePermissionMode('nonsense')).toBe('default')
		expect(normalizePermissionMode(null)).toBe('default')
		expect(normalizePermissionMode(undefined)).toBe('default')
		expect(normalizePermissionMode(7)).toBe('default')
		expect(isPermissionMode('plan')).toBe(true)
		expect(isPermissionMode('planning')).toBe(false)
	})

	test('only bypassPermissions needs an explicit confirm', () => {
		expect(requiresExplicitConfirm('bypassPermissions')).toBe(true)
		for (const mode of ['default', 'plan', 'acceptEdits'] as const) {
			expect(requiresExplicitConfirm(mode)).toBe(false)
		}
	})

	test('every mode has a label', () => {
		for (const mode of ALL_MODES) {
			expect(PERMISSION_MODE_LABELS[mode]?.length).toBeGreaterThan(0)
		}
	})

	test('the conversations enum in the schema matches PERMISSION_MODES', () => {
		const schema = readFileSync(
			fileURLToPath(new URL('../src/lib/sessions/sessions.schema.ts', import.meta.url)),
			'utf8',
		)
		const block = /conversation_permission_mode'?,\s*\[([\s\S]*?)\]/.exec(schema)
		expect(block, 'conversation_permission_mode enum not found').toBeTruthy()
		const values = [...block![1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1])
		expect(values).toEqual([...PERMISSION_MODES])
	})

	test('stripToolNamespace handles bare and MCP-qualified names', () => {
		expect(stripToolNamespace('Write')).toBe('Write')
		expect(stripToolNamespace('mcp__agentstudio__Write')).toBe('Write')
		expect(stripToolNamespace('mcp__agentstudio__push_branch')).toBe('push_branch')
	})
})

// ─────────── Capability classification (#15-proofing) ───────────

test.describe('permission-mode — capabilities rather than literal names', () => {
	test("the SDK's built-in edit tools classify as file edits, so #15 does not un-gate them", () => {
		for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
			expect(toolCapabilities(tool).has('write-file'), `${tool}`).toBe(true)
			expect(
				resolveToolGate({ mode: 'acceptEdits', toolName: tool, settingsRequiresApproval: true }).gate,
			).toBe('allow')
			expect(
				resolveToolGate({ mode: 'plan', toolName: tool, settingsRequiresApproval: false }).gate,
			).not.toBe('allow')
		}
	})

	test("the SDK's built-in read tools classify as read-only", () => {
		for (const tool of ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']) {
			expect(toolCapabilities(tool).has('read'), `${tool}`).toBe(true)
		}
	})

	test('a renamed push-shaped tool is still mandatory', () => {
		for (const tool of ['git_push', 'push_to_remote', 'open_pull_request']) {
			expect(isMandatoryApprovalTool(tool), `${tool}`).toBe(true)
		}
	})

	test('Bash stays unclassified and therefore mutating — never auto-approved by acceptEdits', () => {
		expect(toolCapabilities('Bash').has('mutate')).toBe(true)
		expect(
			resolveToolGate({ mode: 'acceptEdits', toolName: 'Bash', settingsRequiresApproval: true }).gate,
		).toBe('ask')
	})

	test('Task counts as a mutation, so plan mode refuses to delegate (#5)', () => {
		// A `Task` call changes nothing by itself — what it costs is decided by the child.
		// Plan mode hands the SDK 'default', and nothing here has established that a child's
		// own calls reach `canUseTool`, so delegation would be an unobserved channel out of
		// a read-only mode. Refused until that is proven, not assumed safe.
		expect(toolCapabilities('Task').has('read')).toBe(false)
		expect(toolCapabilities('Task').has('mutate')).toBe(true)
		expect(resolveToolGate({ mode: 'plan', toolName: 'Task', settingsRequiresApproval: false }).gate).toBe(
			'deny',
		)
		// It is ordinary work in every other mode: the settings decide, as for any tool.
		expect(
			resolveToolGate({ mode: 'default', toolName: 'Task', settingsRequiresApproval: false }).gate,
		).toBe('allow')
		expect(
			resolveToolGate({ mode: 'default', toolName: 'Task', settingsRequiresApproval: true }).gate,
		).toBe('ask')
	})
})
