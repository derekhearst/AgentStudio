/**
 * The engine's per-call decision: tool scope, workspace containment and the permission
 * gate, composed in one place (`src/lib/engine/tool-decision.ts`), and the scope that feeds
 * it (`src/lib/engine/tool-scope.ts`).
 *
 * Pure — no database, no server — so it runs anywhere.
 *
 * The defect behind most of this file: a scoped agent's tool list went to the SDK as
 * `allowedTools`, which the SDK reads as "auto-approve these". The listed tools skipped every
 * gate (the read-only Research agent could `Read` any file on the host, and the Plan agent's
 * mandatory-approval handoff ran with no approval), while unlisted tools stayed available (the
 * "read-only" agents could still `Edit` and run `Bash`). The scope now restricts, and nothing
 * is auto-approved, so every call meets `decideToolCall`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { READ_ONLY_TOOL_NAMES } from '../src/lib/agents/builtin-agents.server'
import { SUBAGENT_TOOL } from '../src/lib/engine/builtin-tools'
import { decideToolCall, type ToolDecisionContext } from '../src/lib/engine/tool-decision'
import { isToolInScope, resolveToolScope, scopeBuiltinTools } from '../src/lib/engine/tool-scope'

const WS = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa\\runs\\r1' : '/sandbox/user-aaa/runs/r1'

function ctx(overrides: Partial<ToolDecisionContext> = {}): ToolDecisionContext {
	return {
		mode: 'default',
		settingsRequiresApproval: () => false,
		workspaceRoot: WS,
		bashPolicy: 'sandboxed',
		scope: null,
		...overrides,
	}
}

test.describe('tool scope', () => {
	test('a scoped list splits into the SDK built-ins and our own tools', () => {
		const scope = resolveToolScope(['Read', 'Glob', 'web_search', 'request_plan_approval'], { delegation: false })
		expect(scope).not.toBeNull()
		expect(scope!.builtins).toEqual(['Read', 'Glob'])
		expect([...scope!.inHouse].sort()).toEqual(['request_plan_approval', 'web_search'])
		// What `Options.tools` gets: the built-ins that exist for this run, nothing else.
		expect(scopeBuiltinTools(scope)).toEqual(['Read', 'Glob'])
	})

	test('an unscoped run leaves the SDK default in place and allows every tool', () => {
		expect(resolveToolScope(undefined, { delegation: true })).toBeNull()
		expect(scopeBuiltinTools(null)).toBeUndefined()
		expect(isToolInScope(null, 'Bash')).toBe(true)
	})

	test('a scope with no built-ins disables them, rather than meaning "all of them"', () => {
		const scope = resolveToolScope(['web_search'], { delegation: false })
		expect(scopeBuiltinTools(scope)).toEqual([])
	})

	test('delegation adds the Agent tool, and only when there are agents to delegate to', () => {
		// The CLI's delegation tool is `Agent`; `Task` is only its old name. The scope used to
		// hold `Task`, and every delegation — which arrives as `Agent` — was refused.
		expect(SUBAGENT_TOOL).toBe('Agent')
		expect(resolveToolScope(['Read'], { delegation: true })!.builtins).toContain('Agent')
		expect(resolveToolScope(['Read'], { delegation: false })!.builtins).not.toContain('Agent')
	})

	test("a list in the CLI's old tool names is read in its current ones", () => {
		const scope = resolveToolScope(['Read', 'Task', 'KillShell'], { delegation: false })
		// What `Options.tools` gets, and what a call is checked against: today's names.
		expect(scopeBuiltinTools(scope)).toEqual(['Read', 'Agent', 'TaskStop'])
		for (const name of ['Agent', 'Task', 'TaskStop', 'KillShell', 'KillBash']) {
			expect(isToolInScope(scope, name), name).toBe(true)
		}
		expect(scope!.inHouse.size).toBe(0)
	})

	test("the read-only agents' scope actually leaves out the tools that change things", () => {
		// This is what `allowedTools` never did: Bash and Edit were simply not removed.
		const scope = resolveToolScope(READ_ONLY_TOOL_NAMES, { delegation: false })
		for (const name of ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'delete_file', 'push_branch', 'create_automation']) {
			expect(isToolInScope(scope, name), name).toBe(false)
		}
		expect(scopeBuiltinTools(scope)).not.toContain('Bash')
		expect(scopeBuiltinTools(scope)).not.toContain('Edit')
	})
})

test.describe('decideToolCall', () => {
	const readOnly = resolveToolScope(READ_ONLY_TOOL_NAMES, { delegation: false })

	test('Research and Plan can delegate: the call arrives as Agent, not Task', () => {
		// The built-in orchestrators are given subagents whenever a custom agent exists, and
		// told about them in the prompt. The CLI names the call `Agent`.
		const orchestrator = resolveToolScope(READ_ONLY_TOOL_NAMES, { delegation: true })
		const input = { subagent_type: 'reviewer', description: 'Review it', prompt: 'Review the diff' }
		expect(decideToolCall(ctx({ scope: orchestrator }), 'Agent', input).gate).not.toBe('deny')
		expect(decideToolCall(ctx({ scope: orchestrator }), 'Task', input).gate).not.toBe('deny')
		// Without agents to delegate to, the tool stays out of scope.
		expect(decideToolCall(ctx({ scope: readOnly }), 'Agent', input).gate).toBe('deny')
	})

	test('a tool outside the scope is refused before anything else', () => {
		const d = decideToolCall(ctx({ scope: readOnly, mode: 'bypassPermissions' }), 'Bash', { command: 'ls' })
		expect(d.gate).toBe('deny')
		expect(d.reason).toMatch(/not available to this agent/)
	})

	test('a scoped tool is still contained — being on the list approves nothing', () => {
		// The exact failure: Read was on the read-only list, so the SDK auto-approved it and
		// `/proc/self/environ` came back in the transcript.
		const d = decideToolCall(ctx({ scope: readOnly }), 'Read', { file_path: '/proc/self/environ' })
		expect(d.gate).toBe('deny')
		expect(decideToolCall(ctx({ scope: readOnly }), 'Read', { file_path: 'notes.md' }).gate).toBe('allow')
	})

	test('the mandatory-approval handoff asks, in every mode, even for a scoped agent', () => {
		// request_plan_approval switches the conversation's agent. It used to be auto-approved
		// for the Plan agent because it was on the Plan agent's list.
		for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const) {
			const d = decideToolCall(ctx({ scope: readOnly, mode }), 'request_plan_approval', { path: 'PLAN.md' })
			expect(d.gate, mode).toBe('ask')
		}
	})

	test('containment is not waived by bypassPermissions', () => {
		expect(decideToolCall(ctx({ mode: 'bypassPermissions' }), 'Write', { file_path: '/etc/cron.d/x' }).gate).toBe(
			'deny',
		)
	})

	test('an unconfinable Bash asks in default mode — the pending block has to know that', () => {
		// On a host without bubblewrap the gate alone says 'allow' for Bash in default mode;
		// the engine used to show it as executing while canUseTool quietly waited for an
		// approval nobody could give.
		const d = decideToolCall(ctx({ bashPolicy: 'ask' }), 'Bash', { command: 'ls' })
		expect(d.gate).toBe('ask')
	})

	test("plan mode's refusal is not softened to a question by containment", () => {
		// Strictest wins: plan mode denies a shell command outright, even where containment
		// alone would only have asked.
		expect(decideToolCall(ctx({ mode: 'plan', bashPolicy: 'ask' }), 'Bash', { command: 'ls' }).gate).toBe('deny')
	})

	test("writing the agent's own settings asks even under bypassPermissions", () => {
		const d = decideToolCall(ctx({ mode: 'bypassPermissions' }), 'Write', {
			file_path: '.claude/settings.json',
			content: '{"permissions":{"allow":["Bash(*)"]}}',
		})
		expect(d.gate).toBe('ask')
	})

	test('the settings gate still decides everything else', () => {
		expect(decideToolCall(ctx(), 'web_fetch', { url: 'https://example.com' }).gate).toBe('allow')
		expect(
			decideToolCall(ctx({ settingsRequiresApproval: (n) => n === 'web_fetch' }), 'web_fetch', { url: 'x' }).gate,
		).toBe('ask')
	})

	test('a run with no workspace skips containment but keeps the gate', () => {
		expect(decideToolCall(ctx({ workspaceRoot: null }), 'Read', { file_path: '/etc/passwd' }).gate).toBe('allow')
		expect(decideToolCall(ctx({ workspaceRoot: null }), 'push_branch', {}).gate).toBe('ask')
	})
})

test.describe('what buildEngineOptions hands the SDK', () => {
	/*
	 * Read as source because `options.server.ts` imports `$env`, which the Playwright runtime
	 * cannot resolve (the reason `./builtin-tools` exists). The behaviour behind each line is
	 * pinned above and in `engine.engine-env.spec.ts`; this pins that the builder uses it.
	 */
	const source = readFileSync(resolve('src/lib/engine/options.server.ts'), 'utf8')

	test('never sets allowedTools — the SDK reads it as auto-approve', () => {
		expect(source).not.toMatch(/^\s*(\.\.\.\(.*\?\s*\{\s*)?allowedTools\s*:/m)
		expect(source).toMatch(/tools:\s*scopedBuiltins/)
	})

	test('always gives the CLI an allow-listed env, never process.env', () => {
		expect(source).toMatch(/env:\s*cliEnv/)
		expect(source).not.toMatch(/\.\.\.\s*\(?process\.env/)
	})

	test('takes the sandbox from engine-sandbox, which refuses to run a shell command outside it', () => {
		// The settings themselves are pinned in `engine.engine-sandbox.spec.ts`.
		expect(source).toMatch(/sandbox:\s*engineSandboxSettings\(/)
		expect(source).toMatch(/protectedProjectRoot:\s*settingSources\.includes\('project'\)/)
	})
})
