import { expect, test } from '@playwright/test'
import { DNS_TABLE, fakeResolver } from './egress-fixture'
import { getActiveUserId, getSql, readEnvVar } from './helpers'
import { createGuardedLookup } from '../src/lib/tools/egress.server'
import type { McpProbeResult } from '../src/lib/mcp/mcp-probe.server'

/**
 * #17 — connectors as rows (`src/lib/mcp/mcp.server.ts`), against the live database.
 *
 * Server functions called directly, as the remote functions call them, so every write can be
 * checked in the table itself. The Test button's network half is swapped for a stub through
 * `testMcpServer`'s `probe` seam (the real probe is pinned in `mcp.probe.spec.ts`), and run
 * start's host check resolves through the egress fixtures' stand-in DNS, where `public.test` is
 * public and `intranet.test` is 10.1.2.3 — so nothing here leaves the process.
 *
 * What is pinned:
 *   - the token and header values are stored encrypted, never in a readable column, and never
 *     in the list the page gets or in the audit trail
 *   - the name rule and the URL rule are enforced on the server, and the name is unique per user
 *   - an edit that leaves a secret blank keeps it; null removes it; a new value replaces it; and
 *     only a change to the address or the credentials clears the last test result
 *   - the Test button records its outcome, and a failure keeps the last tool list
 *   - run start gives an interactive, unscoped chat run the enabled rows only, with their
 *     headers decrypted, and leaves out — and names — one whose host resolves privately
 *
 * The instance is single-user, and other specs may add connectors for that user while this
 * runs, so every assertion about a list looks only at the rows this spec made.
 */

const TOKEN = 'ghp_e2e_secret_token_1'
const HEADER_VALUE = 'x-team-e2e-secret-value'
const fakeDns = createGuardedLookup(fakeResolver(DNS_TABLE).resolve)

function ensureEncryptionKey() {
	process.env.APP_ENCRYPTION_KEY ||= readEnvVar('APP_ENCRYPTION_KEY') || 'e2e-test-encryption-key'
}

async function server() {
	ensureEncryptionKey()
	return import('../src/lib/mcp/mcp.server')
}

function unique() {
	return Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, 'x')
}

/** A connector name no other spec run can collide with. */
function specName() {
	return `e2e-${unique()}`
}

async function cleanup(ids: string[]) {
	if (ids.length === 0) return
	const sql = getSql()
	await sql`delete from audit_events where target_type = 'mcp_server' and target_id in ${sql(ids)}`
	await sql`delete from mcp_servers where id in ${sql(ids)}`
}

async function rowOf(id: string) {
	const [row] = await getSql()<
		{
			encrypted_secrets: string | null
			header_names: string[]
			has_bearer_token: boolean
			label: string
			enabled: boolean
			tool_policies: Record<string, string>
			tools_snapshot: Array<{ name: string }>
			last_test_ok: boolean | null
			last_error: string | null
			last_tested_at: Date | null
		}[]
	>`
		select encrypted_secrets, header_names, has_bearer_token, label, enabled, tool_policies, tools_snapshot,
			last_test_ok, last_error, last_tested_at
		from mcp_servers where id = ${id}
	`
	return row
}

async function storedSecrets(id: string) {
	const { decryptSecret } = await import('../src/lib/source-control/encryption.server')
	const row = await rowOf(id)
	return row.encrypted_secrets ? (JSON.parse(decryptSecret(row.encrypted_secrets)) as { bearerToken: string | null; headers: Record<string, string> }) : null
}

test.describe('connectors — storing one', () => {
	test('the token and headers are stored encrypted, and the list never carries them', async () => {
		const { createMcpServer, listMcpServers } = await server()
		const userId = await getActiveUserId()
		const ids: string[] = []
		try {
			const created = await createMcpServer(userId, {
				label: 'E2E GitHub',
				name: specName(),
				transport: 'http',
				url: 'https://mcp.example.com/mcp',
				enabled: false,
				bearerToken: TOKEN,
				headers: { 'X-Team': HEADER_VALUE },
			})
			ids.push(created.id)

			expect(created.headerNames).toEqual(['X-Team'])
			expect(created.hasBearerToken).toBe(true)
			expect(Object.keys(created)).not.toContain('encryptedSecrets')
			expect(JSON.stringify(created)).not.toContain(TOKEN)
			expect(JSON.stringify(created)).not.toContain(HEADER_VALUE)

			const listed = (await listMcpServers(userId)).find((s) => s.id === created.id)
			expect(listed).toBeTruthy()
			expect(Object.keys(listed!)).not.toContain('encryptedSecrets')
			expect(JSON.stringify(listed)).not.toContain(TOKEN)
			expect(JSON.stringify(listed)).not.toContain(HEADER_VALUE)

			const row = await rowOf(created.id)
			expect(row.encrypted_secrets).toBeTruthy()
			expect(row.encrypted_secrets).not.toContain(TOKEN)
			expect(row.encrypted_secrets).not.toContain(HEADER_VALUE)
			expect(await storedSecrets(created.id)).toMatchObject({ bearerToken: TOKEN, headers: { 'X-Team': HEADER_VALUE } })

			const audits = await getSql()<{ action: string; after_state: Record<string, unknown> }[]>`
				select action::text as action, after_state from audit_events where target_id = ${created.id}
			`
			expect(audits.map((a) => a.action)).toEqual(['mcp_server.created'])
			expect(audits[0].after_state).toMatchObject({ headerNames: ['X-Team'], hasBearerToken: true })
			expect(JSON.stringify(audits)).not.toContain(TOKEN)
			expect(JSON.stringify(audits)).not.toContain(HEADER_VALUE)
		} finally {
			await cleanup(ids)
		}
	})

	test('a connector with no credentials stores nothing encrypted', async () => {
		const { createMcpServer } = await server()
		const userId = await getActiveUserId()
		const ids: string[] = []
		try {
			const created = await createMcpServer(userId, {
				label: 'E2E Open',
				name: specName(),
				transport: 'sse',
				url: 'https://mcp.example.com/sse',
				enabled: false,
			})
			ids.push(created.id)
			const row = await rowOf(created.id)
			expect(row.encrypted_secrets).toBeNull()
			expect(row.header_names).toEqual([])
			expect(row.has_bearer_token).toBe(false)
		} finally {
			await cleanup(ids)
		}
	})

	test('names and URLs are checked on the server, and a name is unique per user', async () => {
		const { createMcpServer } = await server()
		const { UserInputError } = await import('../src/lib/server/user-input-error')
		const userId = await getActiveUserId()
		const ids: string[] = []
		const attempt = (name: string, url = 'https://mcp.example.com/mcp') =>
			createMcpServer(userId, { label: 'E2E Bad', name, transport: 'http', url, enabled: false }).then(
				(created) => {
					ids.push(created.id)
					return null
				},
				(err: unknown) => err,
			)
		try {
			for (const [name, pattern] of [
				['agentstudio', /reserved/],
				['claude-ai', /reserved/],
				['Bad_Name', /lower-case letters/],
				['', /needs a name/],
			] as const) {
				const err = await attempt(name)
				expect(err, name).toBeInstanceOf(UserInputError)
				expect((err as Error).message, name).toMatch(pattern)
			}
			for (const [url, pattern] of [
				['http://127.0.0.1:9000/mcp', /MCP_ALLOWED_PRIVATE_HOSTS/],
				['https://user:pass@mcp.example.com/mcp', /bearer token or a header/],
				['ftp://mcp.example.com/mcp', /https:\/\//],
			] as const) {
				const err = await attempt(specName(), url)
				expect(err, url).toBeInstanceOf(UserInputError)
				expect((err as Error).message, url).toMatch(pattern)
			}

			const name = specName()
			expect(await attempt(name)).toBeNull()
			const duplicate = await attempt(name)
			expect(duplicate).toBeInstanceOf(UserInputError)
			expect((duplicate as Error).message).toMatch(/already have a connector named/)
		} finally {
			await cleanup(ids)
		}
	})

	test('without APP_ENCRYPTION_KEY a token cannot be stored, but an open server can', async () => {
		const { createMcpServer } = await server()
		const userId = await getActiveUserId()
		const ids: string[] = []
		const key = process.env.APP_ENCRYPTION_KEY
		try {
			delete process.env.APP_ENCRYPTION_KEY
			const err = await createMcpServer(userId, {
				label: 'E2E No Key',
				name: specName(),
				transport: 'http',
				url: 'https://mcp.example.com/mcp',
				enabled: false,
				bearerToken: TOKEN,
			}).then(
				(created) => {
					ids.push(created.id)
					return null
				},
				(e: unknown) => e,
			)
			expect((err as Error | null)?.message).toMatch(/APP_ENCRYPTION_KEY is not set/)

			const open = await createMcpServer(userId, {
				label: 'E2E No Key Open',
				name: specName(),
				transport: 'http',
				url: 'https://mcp.example.com/mcp',
				enabled: false,
			})
			ids.push(open.id)
			expect(open.hasBearerToken).toBe(false)
		} finally {
			if (key === undefined) delete process.env.APP_ENCRYPTION_KEY
			else process.env.APP_ENCRYPTION_KEY = key
			await cleanup(ids)
		}
	})
})

test.describe('connectors — editing one', () => {
	test('blank keeps a secret, null removes it, a value replaces it; only a real change clears the test', async () => {
		const { createMcpServer, updateMcpServer } = await server()
		const userId = await getActiveUserId()
		const ids: string[] = []
		try {
			const created = await createMcpServer(userId, {
				label: 'E2E Edit',
				name: specName(),
				transport: 'http',
				url: 'https://mcp.example.com/mcp',
				enabled: false,
				bearerToken: 'tok-1',
				headers: { 'X-A': 'a1', 'X-B': 'b1' },
			})
			ids.push(created.id)
			const markTested = () =>
				getSql()`update mcp_servers set last_tested_at = now(), last_test_ok = true where id = ${created.id}`
			await markTested()
			const sealedBefore = (await rowOf(created.id)).encrypted_secrets

			// What the edit form sends when only the label changed: a blank token, blank values.
			const relabelled = await updateMcpServer(userId, created.id, {
				label: 'E2E Edit renamed',
				transport: 'http',
				url: 'https://mcp.example.com/mcp',
				timeoutMs: null,
				bearerToken: '',
				headers: { 'X-A': '' },
			})
			expect(relabelled.label).toBe('E2E Edit renamed')
			expect(relabelled.lastTestOk).toBe(true)
			expect((await rowOf(created.id)).encrypted_secrets).toBe(sealedBefore)
			expect(await storedSecrets(created.id)).toMatchObject({ bearerToken: 'tok-1', headers: { 'X-A': 'a1', 'X-B': 'b1' } })

			// Removing a header: gone from the names and the document, and the last test no longer stands.
			const removed = await updateMcpServer(userId, created.id, { headers: { 'X-B': null } })
			expect(removed.headerNames).toEqual(['X-A'])
			expect(removed.lastTestOk).toBeNull()
			expect((await storedSecrets(created.id))?.headers).toEqual({ 'X-A': 'a1' })

			await markTested()
			const replaced = await updateMcpServer(userId, created.id, { bearerToken: 'tok-2' })
			expect(replaced.lastTestOk).toBeNull()
			expect((await storedSecrets(created.id))?.bearerToken).toBe('tok-2')

			const noToken = await updateMcpServer(userId, created.id, { bearerToken: null })
			expect(noToken.hasBearerToken).toBe(false)
			expect((await storedSecrets(created.id))?.bearerToken).toBeNull()

			const bare = await updateMcpServer(userId, created.id, { headers: { 'X-A': null } })
			expect(bare.headerNames).toEqual([])
			expect((await rowOf(created.id)).encrypted_secrets).toBeNull()

			// A new address clears the last test too.
			await markTested()
			const moved = await updateMcpServer(userId, created.id, { url: 'https://other.example.com/mcp' })
			expect(moved.lastTestOk).toBeNull()
			expect(moved.url).toBe('https://other.example.com/mcp')
		} finally {
			await cleanup(ids)
		}
	})

	test('enable, disable, per-tool policy and delete, each audited', async () => {
		const { createMcpServer, deleteMcpServer, setMcpServerEnabled, setMcpToolPolicies } = await server()
		const userId = await getActiveUserId()
		const ids: string[] = []
		try {
			const created = await createMcpServer(userId, {
				label: 'E2E Toggle',
				name: specName(),
				transport: 'http',
				url: 'https://mcp.example.com/mcp',
				enabled: false,
			})
			ids.push(created.id)

			expect((await setMcpServerEnabled(userId, created.id, true)).enabled).toBe(true)
			expect((await setMcpServerEnabled(userId, created.id, false)).enabled).toBe(false)

			const withPolicy = await setMcpToolPolicies(userId, created.id, {
				search_issues: 'allow',
				delete_repo: 'block',
				create_issue: 'ask',
			})
			// `ask` is the default, so it is not stored.
			expect(withPolicy.toolPolicies).toEqual({ search_issues: 'allow', delete_repo: 'block' })
			expect((await rowOf(created.id)).tool_policies).toEqual({ search_issues: 'allow', delete_repo: 'block' })

			await deleteMcpServer(userId, created.id)
			expect(await rowOf(created.id)).toBeUndefined()

			const actions = await getSql()<{ action: string }[]>`
				select action::text as action from audit_events where target_id = ${created.id} order by created_at asc
			`
			expect(actions.map((a) => a.action)).toEqual([
				'mcp_server.created',
				'mcp_server.updated',
				'mcp_server.updated',
				'mcp_server.updated',
				'mcp_server.deleted',
			])
		} finally {
			await cleanup(ids)
		}
	})

	test('another user’s id reaches nothing', async () => {
		const { createMcpServer, deleteMcpServer, setMcpServerEnabled, updateMcpServer } = await server()
		const { UserInputError } = await import('../src/lib/server/user-input-error')
		const userId = await getActiveUserId()
		const stranger = '00000000-0000-4000-8000-000000000000'
		const ids: string[] = []
		try {
			const created = await createMcpServer(userId, {
				label: 'E2E Owned',
				name: specName(),
				transport: 'http',
				url: 'https://mcp.example.com/mcp',
				enabled: false,
			})
			ids.push(created.id)
			for (const attempt of [
				() => updateMcpServer(stranger, created.id, { label: 'hijacked' }),
				() => setMcpServerEnabled(stranger, created.id, true),
				() => deleteMcpServer(stranger, created.id),
			]) {
				await expect(attempt()).rejects.toBeInstanceOf(UserInputError)
			}
			const row = await rowOf(created.id)
			expect(row.label).toBe('E2E Owned')
			expect(row.enabled).toBe(false)
		} finally {
			await cleanup(ids)
		}
	})
})

test.describe('connectors — the Test button', () => {
	test('records the outcome; a failure keeps the last tool list', async () => {
		const { createMcpServer, testMcpServer } = await server()
		const userId = await getActiveUserId()
		const ids: string[] = []
		try {
			const created = await createMcpServer(userId, {
				label: 'E2E Probe',
				name: specName(),
				transport: 'sse',
				url: 'https://mcp.example.com/sse',
				enabled: false,
				bearerToken: TOKEN,
				headers: { 'X-Team': HEADER_VALUE },
			})
			ids.push(created.id)

			const seen: Array<{ url: string; transport: string; headers: Record<string, string> }> = []
			const tool = { name: 'search_issues', title: null, description: 'Search', readOnly: true, destructive: false, openWorld: null }
			const passing = async (input: { url: string; transport: 'http' | 'sse'; headers: Record<string, string> }): Promise<McpProbeResult> => {
				seen.push(input)
				return { ok: true, tools: [tool], server: { name: 'fixture', version: '1' } }
			}
			const ok = await testMcpServer(userId, created.id, { probe: passing })
			expect(ok.result.ok).toBe(true)
			expect(ok.server.lastTestOk).toBe(true)
			expect(ok.server.tools).toEqual([tool])
			// The probe gets the decrypted credentials, the way a run would send them.
			expect(seen[0]).toMatchObject({
				transport: 'sse',
				url: 'https://mcp.example.com/sse',
				headers: { Authorization: `Bearer ${TOKEN}`, 'X-Team': HEADER_VALUE },
			})

			const failing = async (): Promise<McpProbeResult> => ({ ok: false, needsAuth: true, error: 'The server refused the credentials.' })
			const failed = await testMcpServer(userId, created.id, { probe: failing })
			expect(failed.server.lastTestOk).toBe(false)
			expect(failed.server.lastError).toBe('The server refused the credentials.')
			expect(failed.server.tools).toEqual([tool])
			const row = await rowOf(created.id)
			expect(row.last_test_ok).toBe(false)
			expect(row.tools_snapshot.map((t) => t.name)).toEqual(['search_issues'])
		} finally {
			await cleanup(ids)
		}
	})
})

test.describe('connectors — run start', () => {
	test('an interactive, unscoped chat run gets the enabled rows, decrypted, with their blocked tools', async () => {
		const { createMcpServer, loadRunMcpServers, setMcpToolPolicies } = await server()
		const userId = await getActiveUserId()
		const ids: string[] = []
		try {
			const on = await createMcpServer(userId, {
				label: 'E2E Run On',
				name: specName(),
				transport: 'http',
				url: 'https://public.test/mcp',
				enabled: false,
				bearerToken: TOKEN,
				headers: { 'X-Team': HEADER_VALUE },
				timeoutMs: 30_000,
			})
			ids.push(on.id)
			await setMcpToolPolicies(userId, on.id, { delete_repo: 'block', search_issues: 'allow' })
			const off = await createMcpServer(userId, {
				label: 'E2E Run Off',
				name: specName(),
				transport: 'http',
				url: 'https://public.test/mcp',
				enabled: false,
			})
			ids.push(off.id)
			const privateName = await createMcpServer(userId, {
				label: 'E2E Run Intranet',
				name: specName(),
				transport: 'http',
				url: 'https://intranet.test/mcp',
				enabled: false,
			})
			ids.push(privateName.id)
			// Switched on only now, and only for the length of this test, so no chat run elsewhere
			// in the suite picks them up for longer than it has to.
			await getSql()`update mcp_servers set enabled = true where id in ${getSql()([on.id, privateName.id])}`

			const run = await loadRunMcpServers({ userId, runSource: 'chat_stream', toolScoped: false }, { lookup: fakeDns })

			expect(run.servers[on.name]).toEqual({
				type: 'http',
				url: 'https://public.test/mcp',
				headers: { 'X-Team': HEADER_VALUE, Authorization: `Bearer ${TOKEN}` },
				timeout: 30_000,
			})
			expect(run.servers[off.name]).toBeUndefined()
			expect(run.servers[privateName.name]).toBeUndefined()

			expect(run.connectors.get(on.name)?.id).toBe(on.id)
			expect(run.connectors.get(on.name)?.policies.get('search_issues')).toBe('allow')
			expect(run.disallowedTools).toContain(`mcp__${on.name}__delete_repo`)
			expect(run.disallowedTools).not.toContain(`mcp__${on.name}__search_issues`)

			const skipped = run.skipped.find((s) => s.name === privateName.name)
			expect(skipped?.reason).toMatch(/resolves to 10\.1\.2\.3/)
			// One notice for everything left out. It names up to five; this spec's rows are the newest.
			expect(run.notices).toHaveLength(1)
			expect(run.notices[0]).toMatchObject({ kind: 'mcp_unavailable', level: 'warn', persist: false })
			if (run.skipped.length <= 5) expect(run.notices[0].detail).toContain(privateName.name)
			expect(JSON.stringify(run.notices)).not.toContain(TOKEN)
		} finally {
			await cleanup(ids)
		}
	})

	test('a run anywhere else, or with a fixed tool list, gets none', async () => {
		const { loadRunMcpServers } = await server()
		const userId = await getActiveUserId()
		for (const input of [
			{ userId, runSource: 'chat_stream', toolScoped: true },
			{ userId, runSource: 'automation', toolScoped: false },
		]) {
			const run = await loadRunMcpServers(input, { lookup: fakeDns })
			expect(run.servers, JSON.stringify(input)).toEqual({})
			expect(run.connectors.size).toBe(0)
			expect(run.disallowedTools).toEqual([])
			expect(run.notices).toEqual([])
		}
	})
})
