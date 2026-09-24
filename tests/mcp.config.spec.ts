import { expect, test } from '@playwright/test'
import {
	EMPTY_SECRETS,
	MAX_CONNECTOR_HEADERS,
	applySecretsPatch,
	bearerTokenProblem,
	checkMcpUrl,
	connectorNameProblem,
	connectorRequestHeaders,
	connectorSecretsProblem,
	hasSecrets,
	normalizeToolPolicies,
	parseAllowedPrivateHosts,
	parseSecrets,
	serializeSecrets,
	suggestConnectorName,
	toSdkServerConfig,
} from '../src/lib/mcp/mcp-config'

/**
 * #17 — the rules a connector's configuration has to meet (`src/lib/mcp/mcp-config.ts`).
 *
 * Pure: no database, no SvelteKit, no network, so this runs anywhere.
 *
 * What is pinned:
 *   - the name rule. The name is the `<server>` in `mcp__<server>__<tool>`, so it has to be
 *     spelled the way the CLI will spell it, split in exactly one place, and never be ours
 *   - the URL rule: public internet only, by the egress guard's policy, unless the operator
 *     names the host in MCP_ALLOWED_PRIVATE_HOSTS; never credentials in the URL
 *   - the header and token rules, and how an edit that never saw the stored secrets merges
 *     with them: blank keeps, null removes
 *   - the config the SDK is handed
 */

test.describe('connector names', () => {
	test('lower-case letters and digits in hyphenated runs are accepted', () => {
		for (const name of ['github', 'my-tracker', 'a1', 'linear-2', 'x'.repeat(32)]) {
			expect(connectorNameProblem(name), name).toBeNull()
		}
	})

	test('anything the CLI would respell, or that would split ambiguously, is refused', () => {
		for (const name of ['', 'GitHub', 'my_server', 'a__b', 'a--b', '-a', 'a-', 'has space', 'dot.name', 'x'.repeat(33)]) {
			expect(connectorNameProblem(name), name).not.toBeNull()
		}
	})

	test('our own server name and the CLI’s own server names are reserved', () => {
		for (const name of ['agentstudio', 'workspace', 'ide', 'memory', 'hearthbot', 'claude', 'claude-ai', 'claudeai']) {
			expect(connectorNameProblem(name), name).toMatch(/reserved/)
		}
	})

	test('the suggested name follows the label and passes the rule', () => {
		expect(suggestConnectorName('GitHub Issues')).toBe('github-issues')
		expect(suggestConnectorName('  My   Tracker!! ')).toBe('my-tracker')
		const long = suggestConnectorName('An extremely long connector label that keeps going and going')
		expect(long.length).toBeLessThanOrEqual(32)
		expect(connectorNameProblem(long)).toBeNull()
	})
})

test.describe('connector URLs', () => {
	test('a public https URL is accepted', () => {
		const check = checkMcpUrl('https://api.githubcopilot.com/mcp/')
		expect(check.ok).toBe(true)
		if (check.ok) expect(check.cleartext).toBe(false)
	})

	test('plain http is accepted but marked cleartext', () => {
		const check = checkMcpUrl('http://mcp.example.com/sse')
		expect(check.ok).toBe(true)
		if (check.ok) expect(check.cleartext).toBe(true)
	})

	test('other schemes, credentials in the URL and garbage are refused', () => {
		expect(checkMcpUrl('ftp://example.com/mcp').ok).toBe(false)
		expect(checkMcpUrl('file:///etc/passwd').ok).toBe(false)
		expect(checkMcpUrl('not a url').ok).toBe(false)
		expect(checkMcpUrl('').ok).toBe(false)
		const creds = checkMcpUrl('https://user:secret@example.com/mcp')
		expect(creds.ok).toBe(false)
		if (!creds.ok) expect(creds.error).toMatch(/bearer token or a header/)
	})

	test('private, loopback and metadata addresses are refused by the egress policy', () => {
		for (const url of [
			'http://localhost:3000/mcp',
			'http://127.0.0.1/mcp',
			'http://[::1]/mcp',
			'http://169.254.169.254/latest',
			'http://192.168.1.10:8080/mcp',
			'http://router/mcp',
			'http://nas.local/mcp',
			'http://2130706433/mcp',
		]) {
			const check = checkMcpUrl(url)
			expect(check.ok, url).toBe(false)
			if (!check.ok) expect(check.error, url).toMatch(/MCP_ALLOWED_PRIVATE_HOSTS/)
		}
	})

	test('a host the operator allows is exempt, and only that host', () => {
		const allowed = parseAllowedPrivateHosts('NAS.local, 192.168.1.10  [::1]')
		expect([...allowed].sort()).toEqual(['192.168.1.10', '::1', 'nas.local'])

		expect(checkMcpUrl('http://nas.local/mcp', allowed).ok).toBe(true)
		expect(checkMcpUrl('http://192.168.1.10:8080/mcp', allowed).ok).toBe(true)
		expect(checkMcpUrl('http://[::1]:9000/mcp', allowed).ok).toBe(true)
		expect(checkMcpUrl('http://192.168.1.11/mcp', allowed).ok).toBe(false)
		expect(checkMcpUrl('http://other.local/mcp', allowed).ok).toBe(false)
		// Still no credentials in the URL, allowed host or not.
		expect(checkMcpUrl('http://u:p@nas.local/mcp', allowed).ok).toBe(false)
		expect(parseAllowedPrivateHosts(undefined).size).toBe(0)
	})
})

test.describe('headers and the bearer token', () => {
	test('a token and ordinary headers are accepted', () => {
		expect(connectorSecretsProblem({ bearerToken: 'ghp_abc123', headers: { 'X-Api-Key': 'k', 'X-Team': 't' } })).toBeNull()
	})

	test('headers the connection owns are refused', () => {
		for (const name of ['Host', 'Content-Length', 'Content-Type', 'Accept', 'Transfer-Encoding', 'Mcp-Session-Id', 'MCP-Protocol-Version']) {
			expect(connectorSecretsProblem({ bearerToken: null, headers: { [name]: 'x' } }), name).toMatch(/set by the connection/)
		}
	})

	test('bad names, line breaks, duplicates and too many headers are refused', () => {
		expect(connectorSecretsProblem({ bearerToken: null, headers: { 'X Bad': 'x' } })).toMatch(/not a valid header name/)
		expect(connectorSecretsProblem({ bearerToken: null, headers: { 'X-Key': 'a\r\nInjected: yes' } })).toMatch(/line break/)
		expect(connectorSecretsProblem({ bearerToken: null, headers: { 'X-Key': 'a', 'x-key': 'b' } })).toMatch(/twice/)
		const many = Object.fromEntries(Array.from({ length: MAX_CONNECTOR_HEADERS + 1 }, (_, i) => [`X-H${i}`, 'v']))
		expect(connectorSecretsProblem({ bearerToken: null, headers: many })).toMatch(/at most/)
		expect(connectorSecretsProblem({ bearerToken: null, headers: { 'X-Big': 'v'.repeat(8193) } })).toMatch(/longer than/)
	})

	test('a bearer token and an Authorization header cannot both be set', () => {
		expect(connectorSecretsProblem({ bearerToken: 'tok', headers: { authorization: 'Basic x' } })).toMatch(/not both/)
		expect(connectorSecretsProblem({ bearerToken: null, headers: { Authorization: 'Basic x' } })).toBeNull()
	})

	test('a token is the token alone', () => {
		expect(bearerTokenProblem('Bearer abc')).toMatch(/without "Bearer "/)
		expect(bearerTokenProblem('')).not.toBeNull()
		expect(bearerTokenProblem('abc.def-ghi_jkl')).toBeNull()
	})

	test('every request carries the headers and the token as Authorization: Bearer', () => {
		expect(connectorRequestHeaders({ bearerToken: 'tok', headers: { 'X-Team': 't' } })).toEqual({
			'X-Team': 't',
			Authorization: 'Bearer tok',
		})
		expect(connectorRequestHeaders(EMPTY_SECRETS)).toEqual({})
	})
})

test.describe('an edit merges with secrets it never saw', () => {
	const stored = { bearerToken: 'old-token', headers: { 'X-Api-Key': 'old-key', 'X-Team': 'blue' } }

	test('blank or omitted keeps what is stored', () => {
		expect(applySecretsPatch(stored, {})).toEqual(stored)
		expect(applySecretsPatch(stored, { bearerToken: '', headers: { 'X-Api-Key': '' } })).toEqual(stored)
		expect(applySecretsPatch(stored, { bearerToken: '   ' })).toEqual(stored)
	})

	test('null removes', () => {
		expect(applySecretsPatch(stored, { bearerToken: null, headers: { 'X-Team': null } })).toEqual({
			bearerToken: null,
			headers: { 'X-Api-Key': 'old-key' },
		})
	})

	test('a value replaces, matching the header name without regard to case', () => {
		expect(applySecretsPatch(stored, { bearerToken: 'new-token', headers: { 'x-api-key': 'new-key', 'X-New': 'n' } })).toEqual({
			bearerToken: 'new-token',
			headers: { 'X-Team': 'blue', 'x-api-key': 'new-key', 'X-New': 'n' },
		})
	})

	test('the stored document round-trips, and a damaged one reads as empty', () => {
		expect(parseSecrets(serializeSecrets(stored))).toEqual(stored)
		expect(parseSecrets('not json')).toEqual({ bearerToken: null, headers: {} })
		expect(parseSecrets(JSON.stringify({ headers: { ok: 'v', bad: 42 }, bearerToken: 7 }))).toEqual({
			bearerToken: null,
			headers: { ok: 'v' },
		})
		expect(hasSecrets(EMPTY_SECRETS)).toBe(false)
		expect(hasSecrets({ bearerToken: 't', headers: {} })).toBe(true)
	})
})

test.describe('what the SDK is handed', () => {
	test('an http connector with headers and a timeout', () => {
		expect(
			toSdkServerConfig(
				{ transport: 'http', url: 'https://example.com/mcp', timeoutMs: 30_000 },
				{ Authorization: 'Bearer t' },
			),
		).toEqual({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' }, timeout: 30_000 })
	})

	test('an sse connector with nothing optional, and never alwaysLoad', () => {
		const config = toSdkServerConfig({ transport: 'sse', url: 'https://example.com/sse', timeoutMs: null }, {})
		expect(config).toEqual({ type: 'sse', url: 'https://example.com/sse' })
		expect('alwaysLoad' in config).toBe(false)
	})
})

test.describe('stored tool policy', () => {
	test('keeps allow and block, drops ask (the default) and anything unknown', () => {
		expect(
			normalizeToolPolicies({
				search_issues: 'allow',
				delete_repo: 'block',
				create_issue: 'ask',
				weird: 'maybe',
				'  ': 'allow',
				spaced: 'allow',
			}),
		).toEqual({ search_issues: 'allow', delete_repo: 'block', spaced: 'allow' })
		expect(normalizeToolPolicies(null)).toEqual({})
	})
})
