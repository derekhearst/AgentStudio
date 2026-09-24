import { expect, test } from '@playwright/test'
import {
	CONNECTOR_PROVENANCE_SOURCE,
	buildRunMcpConnectors,
	cliToolNameSegment,
	composeMcpServers,
	connectorCallVerdict,
	connectorDisallowedTools,
	type RunMcpConnectors,
} from '../src/lib/engine/mcp-connectors'
import {
	OWN_MCP_SERVER,
	PERMISSION_MODES,
	resolveToolGate,
	type ExternalToolPolicy,
} from '../src/lib/engine/permission-mode'
import { decideToolCall, type ToolDecisionContext } from '../src/lib/engine/tool-decision'
import { resolveToolScope } from '../src/lib/engine/tool-scope'
import { DISALLOWED_MCP_RESOURCE_TOOLS } from '../src/lib/engine/builtin-tools'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

/**
 * #17 — connectors in the engine's tool gate: `src/lib/engine/mcp-connectors.ts`, and how
 * `tool-decision.ts` and `permission-mode.ts` apply a connector's per-tool policy.
 *
 * Pure — no database, no server — so it runs anywhere.
 *
 * The rule under all of it: trust is keyed on the connector's configuration row, never on a
 * name the server chose. A call's `<server>` must be one of the run's rows, the SDK's
 * provenance for the call must agree (source `dynamic`, same key), and only then does the
 * row's policy for the tool apply. Without provenance, `allow` degrades to `ask`.
 */

const DYNAMIC = (name: string) => ({ name, source: CONNECTOR_PROVENANCE_SOURCE })

function connectors(): RunMcpConnectors {
	return buildRunMcpConnectors([
		{
			id: 'row-github',
			name: 'github',
			toolPolicies: { search_issues: 'allow', delete_repo: 'block', create_issue: 'ask' },
		},
		{ id: 'row-linear', name: 'linear', toolPolicies: {} },
	])
}

test.describe('which row a call belongs to', () => {
	test('a configured connector with matching provenance gets its row’s policy', () => {
		const set = connectors()
		expect(connectorCallVerdict(set, 'mcp__github__search_issues', DYNAMIC('github'))).toEqual({
			kind: 'policy',
			policy: 'allow',
			connectorId: 'row-github',
		})
		expect(connectorCallVerdict(set, 'mcp__github__delete_repo', DYNAMIC('github'))).toMatchObject({ policy: 'block' })
		// A tool with no entry — including one the server added since the last test — asks.
		expect(connectorCallVerdict(set, 'mcp__github__brand_new_tool', DYNAMIC('github'))).toMatchObject({ policy: 'ask' })
		expect(connectorCallVerdict(set, 'mcp__linear__create_issue', DYNAMIC('linear'))).toMatchObject({
			policy: 'ask',
			connectorId: 'row-linear',
		})
	})

	test('a server that is not one of this run’s connectors is refused', () => {
		const verdict = connectorCallVerdict(connectors(), 'mcp__somebodyelse__search_issues', DYNAMIC('somebodyelse'))
		expect(verdict?.kind).toBe('refused')
		expect(connectorCallVerdict(new Map(), 'mcp__github__search_issues', DYNAMIC('github'))?.kind).toBe('refused')
	})

	test('provenance that disagrees with the row is refused, whatever the name says', () => {
		const set = connectors()
		// Our in-process kind of server, a different key, a different configuration scope.
		for (const provenance of [
			{ name: 'github', source: 'sdk' },
			{ name: 'linear', source: CONNECTOR_PROVENANCE_SOURCE },
			{ name: 'github', source: 'project' },
			{ name: 'github', source: 'claudeai' },
			{ name: 'github', source: 'something-new' },
		]) {
			expect(connectorCallVerdict(set, 'mcp__github__search_issues', provenance)?.kind, JSON.stringify(provenance)).toBe(
				'refused',
			)
		}
	})

	test('with no provenance reported, allow asks instead; block stays block', () => {
		const set = connectors()
		expect(connectorCallVerdict(set, 'mcp__github__search_issues', null)).toMatchObject({ policy: 'ask' })
		expect(connectorCallVerdict(set, 'mcp__github__delete_repo', null)).toMatchObject({ policy: 'block' })
	})

	test('before anything is reported (the frame decision), the row’s policy stands', () => {
		expect(connectorCallVerdict(connectors(), 'mcp__github__search_issues', undefined)).toMatchObject({ policy: 'allow' })
	})

	test('built-ins and our own tools are not its business', () => {
		const set = connectors()
		expect(connectorCallVerdict(set, 'Write', null)).toBeNull()
		expect(connectorCallVerdict(set, `mcp__${OWN_MCP_SERVER}__file_read`, null)).toBeNull()
	})
})

test.describe('building the run’s connectors', () => {
	test('a policy is found under the name the CLI gives the tool', () => {
		// The CLI rewrites anything outside [a-zA-Z0-9_-] to `_` (checked in the bundled CLI).
		expect(cliToolNameSegment('tools/list.v2')).toBe('tools_list_v2')
		expect(cliToolNameSegment('ok-name_1')).toBe('ok-name_1')
		const set = buildRunMcpConnectors([{ id: 'r', name: 'docs', toolPolicies: { 'pages/read': 'allow' } }])
		expect(connectorCallVerdict(set, 'mcp__docs__pages_read', DYNAMIC('docs'))).toMatchObject({ policy: 'allow' })
	})

	test('two names the CLI spells the same way take the stricter policy', () => {
		const set = buildRunMcpConnectors([{ id: 'r', name: 'docs', toolPolicies: { 'a.b': 'allow', 'a/b': 'block' } }])
		expect(connectorCallVerdict(set, 'mcp__docs__a_b', DYNAMIC('docs'))).toMatchObject({ policy: 'block' })
	})

	test('a row with an invalid name, or a policy that is not one of the three, is ignored', () => {
		const set = buildRunMcpConnectors([
			{ id: 'bad', name: 'Not_Valid', toolPolicies: { x: 'allow' } },
			{ id: 'ours', name: OWN_MCP_SERVER, toolPolicies: { x: 'allow' } },
			{ id: 'ok', name: 'ok', toolPolicies: { x: 'yes please', y: 'allow' } },
		])
		expect([...set.keys()]).toEqual(['ok'])
		expect(connectorCallVerdict(set, 'mcp__ok__x', DYNAMIC('ok'))).toMatchObject({ policy: 'ask' })
		expect(connectorCallVerdict(set, 'mcp__ok__y', DYNAMIC('ok'))).toMatchObject({ policy: 'allow' })
	})

	test('blocked tools become disallowedTools, so the model never sees them', () => {
		expect(connectorDisallowedTools(connectors())).toEqual(['mcp__github__delete_repo'])
	})
})

test.describe('the gate, across every mode', () => {
	const gate = (mode: (typeof PERMISSION_MODES)[number], externalPolicy?: ExternalToolPolicy) =>
		resolveToolGate({ mode, toolName: 'mcp__github__search_issues', settingsRequiresApproval: false, externalPolicy }).gate

	test('block refuses in every mode, bypass included', () => {
		for (const mode of PERMISSION_MODES) expect(gate(mode, 'block'), mode).toBe('deny')
	})

	test('allow runs in Ask and Accept-edits, is still refused in Plan, and runs in Bypass', () => {
		expect(gate('default', 'allow')).toBe('allow')
		expect(gate('acceptEdits', 'allow')).toBe('allow')
		expect(gate('plan', 'allow')).toBe('deny')
		expect(gate('bypassPermissions', 'allow')).toBe('allow')
	})

	test('ask — and no policy at all — is the posture from before connectors', () => {
		for (const policy of ['ask', undefined] as const) {
			expect(gate('default', policy)).toBe('ask')
			expect(gate('acceptEdits', policy)).toBe('ask')
			expect(gate('plan', policy)).toBe('deny')
			expect(gate('bypassPermissions', policy)).toBe('allow')
		}
	})

	test('“Require approval for all tools” still asks for a tool its connector allows', () => {
		// For an external name the settings callback is true only under the `'*'` wildcard: the
		// per-tool list enumerates our registry, so nobody can tick a connector's tool on it.
		for (const mode of ['default', 'acceptEdits'] as const) {
			const decision = resolveToolGate({
				mode,
				toolName: 'mcp__github__search_issues',
				settingsRequiresApproval: true,
				externalPolicy: 'allow',
			})
			expect(decision.gate, mode).toBe('ask')
			expect(decision.reason, mode).toMatch(/Require approval for all tools/)
		}
	})

	test('the settings never loosen a connector tool: ask still asks, block still refuses', () => {
		expect(
			resolveToolGate({ mode: 'default', toolName: 'mcp__github__x', settingsRequiresApproval: false, externalPolicy: 'ask' })
				.gate,
		).toBe('ask')
		expect(
			resolveToolGate({ mode: 'default', toolName: 'mcp__github__x', settingsRequiresApproval: false, externalPolicy: 'block' })
				.gate,
		).toBe('deny')
	})

	test('a policy means nothing for a tool that is not external', () => {
		expect(resolveToolGate({ mode: 'default', toolName: 'Bash', settingsRequiresApproval: true, externalPolicy: 'allow' }).gate).toBe(
			'ask',
		)
		expect(
			resolveToolGate({ mode: 'bypassPermissions', toolName: 'push_branch', settingsRequiresApproval: false, externalPolicy: 'allow' })
				.gate,
		).toBe('ask')
		expect(resolveToolGate({ mode: 'default', toolName: 'Read', settingsRequiresApproval: false, externalPolicy: 'block' }).gate).toBe(
			'allow',
		)
	})
})

test.describe('one call, decided end to end', () => {
	const WS = process.platform === 'win32' ? 'C:\\sandbox\\u1\\runs\\r1' : '/sandbox/u1/runs/r1'
	const ctx = (overrides: Partial<ToolDecisionContext> = {}): ToolDecisionContext => ({
		mode: 'default',
		settingsRequiresApproval: () => false,
		workspaceRoot: WS,
		bashPolicy: 'sandboxed',
		scope: null,
		connectors: connectors(),
		...overrides,
	})

	test('allowed, asked and blocked tools of a configured connector', () => {
		expect(decideToolCall(ctx(), 'mcp__github__search_issues', {}, DYNAMIC('github')).gate).toBe('allow')
		expect(decideToolCall(ctx(), 'mcp__github__create_issue', {}, DYNAMIC('github')).gate).toBe('ask')
		const blocked = decideToolCall(ctx(), 'mcp__github__delete_repo', {}, DYNAMIC('github'))
		expect(blocked.gate).toBe('deny')
		expect(blocked.reason).toMatch(/blocked/)
	})

	test('the SDK reporting nothing means asking, never running unasked', () => {
		expect(decideToolCall(ctx(), 'mcp__github__search_issues', {}, null).gate).toBe('ask')
	})

	test('an unconfigured server is refused, with a reason the model can read', () => {
		const decision = decideToolCall(ctx(), 'mcp__intruder__search_issues', {}, DYNAMIC('intruder'))
		expect(decision.gate).toBe('deny')
		expect(decision.reason).toMatch(/not a connector configured for this run/)
	})

	test('our own name from any source but the in-process one is refused', () => {
		expect(decideToolCall(ctx(), 'file_read', {}, { name: OWN_MCP_SERVER, source: 'dynamic' }).gate).toBe('deny')
		expect(decideToolCall(ctx(), 'file_read', {}, { name: OWN_MCP_SERVER, source: 'sdk' }).gate).toBe('allow')
	})

	test('an agent’s fixed tool list still refuses connector tools first', () => {
		const scope = resolveToolScope(['Read'], { delegation: false })
		const decision = decideToolCall(ctx({ scope }), 'mcp__github__search_issues', {}, DYNAMIC('github'))
		expect(decision.gate).toBe('deny')
		expect(decision.reason).toMatch(/not available to this agent/)
	})

	test('without a connector set, the old posture holds: every external tool asks', () => {
		expect(decideToolCall(ctx({ connectors: undefined }), 'mcp__whoever__x', {}, null).gate).toBe('ask')
	})

	test('plan mode refuses even an allowed connector tool', () => {
		expect(decideToolCall(ctx({ mode: 'plan' }), 'mcp__github__search_issues', {}, DYNAMIC('github')).gate).toBe('deny')
	})
})

test.describe('the SDK options', () => {
	const own = { type: 'sdk', name: OWN_MCP_SERVER } as unknown as McpServerConfig
	const external = {
		github: { type: 'http' as const, url: 'https://api.example.com/mcp' },
		[OWN_MCP_SERVER]: { type: 'http' as const, url: 'https://impostor.example.com/mcp' },
		Bad_Name: { type: 'sse' as const, url: 'https://example.com/sse' },
	}

	test('connectors go in beside ours; ours cannot be shadowed and bad names are dropped', () => {
		const servers = composeMcpServers({ own, external, scoped: false })
		expect(Object.keys(servers).sort()).toEqual([OWN_MCP_SERVER, 'github'].sort())
		expect(servers[OWN_MCP_SERVER]).toBe(own)
		expect(servers.github).toEqual(external.github)
	})

	test('a run whose agent has a fixed tool list gets no connectors', () => {
		expect(composeMcpServers({ own, external, scoped: true })).toEqual({ [OWN_MCP_SERVER]: own })
		expect(composeMcpServers({ own, external: null, scoped: false })).toEqual({ [OWN_MCP_SERVER]: own })
	})

	test('the CLI’s generic MCP resource readers are refused on every run', () => {
		// They name the server in an argument, so no connector policy could see which one.
		expect([...DISALLOWED_MCP_RESOURCE_TOOLS]).toEqual(['ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'])
	})
})
