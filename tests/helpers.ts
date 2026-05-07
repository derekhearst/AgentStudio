import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'

type ParsedEnv = {
	DATABASE_URL: string
}

let cachedEnv: ParsedEnv | null = null
let cachedEnvValues: Map<string, string> | null = null
let sqlClient: postgres.Sql | null = null

function parseEnvFile() {
	if (cachedEnv) return cachedEnv

	const envPath = join(process.cwd(), '.env')
	const raw = readFileSync(envPath, 'utf8')
	const values = new Map<string, string>()

	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eqIndex = trimmed.indexOf('=')
		if (eqIndex === -1) continue
		const key = trimmed.slice(0, eqIndex).trim()
		let value = trimmed.slice(eqIndex + 1).trim()
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		values.set(key, value)
	}

	cachedEnvValues = values

	const DATABASE_URL = values.get('DATABASE_URL')
	if (!DATABASE_URL) {
		throw new Error('DATABASE_URL must exist in .env for Playwright tests')
	}

	cachedEnv = { DATABASE_URL }
	return cachedEnv
}

export function readEnvVar(name: string) {
	parseEnvFile()
	return cachedEnvValues?.get(name)
}

export function uniquePrefix(scope: string) {
	return `E2E:${scope}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

function createSessionToken() {
	return randomBytes(32).toString('base64url')
}

async function ensureSeededUser(): Promise<string> {
	const sql = getSql()
	const [existing] = await sql<{ id: string; password_hash: string | null }[]>`
		select id, password_hash from users limit 1
	`
	if (existing?.id && existing.password_hash) return existing.id

	// Single-user singleton: insert if missing, otherwise update with a hash from AUTH_PASSWORD.
	const password = readEnvVar('AUTH_PASSWORD')
	if (!password) throw new Error('AUTH_PASSWORD must be set in .env for E2E user seeding')

	const { hash } = await import('@node-rs/argon2')
	const passwordHash = await hash(password, {
		memoryCost: 65536,
		timeCost: 3,
		parallelism: 1,
	})

	if (existing?.id) {
		await sql`update users set password_hash = ${passwordHash} where id = ${existing.id}`
		return existing.id
	}

	const [created] = await sql<{ id: string }[]>`
		insert into users (name, username, password_hash)
		values ('E2E Admin', ${`e2e_admin_${Date.now()}`}, ${passwordHash})
		returning id
	`
	if (!created?.id) throw new Error('Failed to seed singleton user for E2E authentication')
	return created.id
}

export async function authenticateContext(context: BrowserContext) {
	const token = createSessionToken()
	const tokenHash = createHash('sha256').update(token).digest('base64url')
	const sql = getSql()

	const userId = await ensureSeededUser()

	const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
	await sql`
		insert into auth_sessions (user_id, token_hash, expires_at)
		values (${userId}, ${tokenHash}, ${expiresAt})
	`

	await context.addCookies([
		{
			name: 'AgentStudio_session',
			value: token,
			url: 'http://127.0.0.1:4173',
			httpOnly: true,
			sameSite: 'Lax',
			secure: false,
		},
	])
}

export async function loginViaUi(page: Page) {
	await authenticateContext(page.context())
	await page.goto('/')
}

export function getSql() {
	if (!sqlClient) {
		const { DATABASE_URL } = parseEnvFile()
		sqlClient = postgres(DATABASE_URL, { max: 1 })
	}
	return sqlClient
}

async function tableExists(tableName: string) {
	const sql = getSql()
	const [row] = await sql<{ exists: boolean }[]>`
		select exists (
			select 1
			from information_schema.tables
			where table_schema = 'public' and table_name = ${tableName}
		) as exists
	`
	return Boolean(row?.exists)
}

export async function cleanupPrefixedRecords(prefix: string) {
	const sql = getSql()

	if ((await tableExists('agent_runs')) && (await tableExists('agent_tasks'))) {
		await sql`delete from agent_runs where task_id in (select id from agent_tasks where title like ${`${prefix}%`})`
	}
	if (await tableExists('agent_tasks')) {
		await sql`delete from agent_tasks where title like ${`${prefix}%`} or description like ${`${prefix}%`}`
	}
	await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
	await sql`delete from conversations where title like ${`${prefix}%`}`
	await sql`delete from notifications where title like ${`${prefix}%`} or body like ${`${prefix}%`}`
	await sql`delete from push_subscriptions where device_label like ${`${prefix}%`}`
	await sql`delete from agents where name like ${`${prefix}%`} or role like ${`${prefix}%`}`
}

export async function expectRealAssistantReply(conversationId: string, timeoutMs = 90000) {
	const sql = getSql()
	const startedAt = Date.now()

	while (Date.now() - startedAt < timeoutMs) {
		const rows = await sql<{ content: string }[]>`
			select content
			from messages
			where conversation_id = ${conversationId} and role = 'assistant'
			order by created_at desc
			limit 1
		`

		const content = rows[0]?.content ?? ''
		if (content.length > 8 && !content.includes('MOCK_STREAM:') && !content.includes('MOCK_RESPONSE:')) {
			return content
		}

		await new Promise((resolve) => setTimeout(resolve, 500))
	}

	throw new Error(`Timed out waiting for real assistant response for conversation ${conversationId}`)
}

export async function seedAgent(
	prefix: string,
	overrides?: { name?: string; role?: string; status?: 'active' | 'paused' | 'idle' },
) {
	const sql = getSql()
	const [row] = await sql<
		{
			id: string
			name: string
		}[]
	>`
		insert into agents (name, role, system_prompt, model, status)
		values (
			${overrides?.name ?? `${prefix} Agent`},
			${overrides?.role ?? `${prefix} role`},
			${`${prefix} system prompt`},
			${'anthropic/claude-sonnet-4'},
			${overrides?.status ?? 'idle'}
		)
		returning id, name
	`
	return row
}

export async function seedTask(
	prefix: string,
	agentId: string,
	overrides?: {
		title?: string
		description?: string
		status?: 'pending' | 'running' | 'review' | 'completed' | 'failed'
		priority?: number
	},
) {
	const sql = getSql()
	const [row] = await sql<{ id: string; title: string }[]>`
		insert into agent_tasks (agent_id, title, description, status, priority, result)
		values (
			${agentId},
			${overrides?.title ?? `${prefix} Task`},
			${overrides?.description ?? `${prefix} task description`},
			${overrides?.status ?? 'pending'},
			${overrides?.priority ?? 2},
			'{}'::jsonb
		)
		returning id, title
	`
	return row
}

/**
 * Resolve the built-in Chat agent id. Conversations require a non-null agent_id after the
 * modes-into-agents migration; tests that don't care about which agent the conversation is
 * bound to fall back to this helper.
 */
export async function getBuiltinChatAgentId(): Promise<string> {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`select id from agents where builtin_key = 'chat' limit 1`
	if (!row) throw new Error('Built-in Chat agent not seeded — restart dev server to run seedBuiltinAgents()')
	return row.id
}

export async function seedConversation(
	prefix: string,
	overrides?: { title?: string; userMessage?: string; assistantMessage?: string; userId?: string; agentId?: string },
) {
	const sql = getSql()
	const userId = overrides?.userId ?? (await getActiveAdminUserId())
	const agentId = overrides?.agentId ?? (await getBuiltinChatAgentId())
	const [conversation] = await sql<{ id: string; title: string }[]>`
		insert into conversations (user_id, agent_id, title, model, total_tokens, total_cost)
		values (${userId}, ${agentId}, ${overrides?.title ?? `${prefix} Conversation`}, ${'anthropic/claude-sonnet-4'}, 42, '0')
		returning id, title
	`

	await sql`
		insert into messages (conversation_id, role, content, metadata, tool_calls, tokens_in, tokens_out, cost, sequence)
		values
			(${conversation.id}, ${'user'}, ${overrides?.userMessage ?? `${prefix} user message`}, '{}'::jsonb, '[]'::jsonb, 12, 0, '0', 1),
			(${conversation.id}, ${'assistant'}, ${overrides?.assistantMessage ?? `${prefix} assistant reply`}, '{}'::jsonb, '[]'::jsonb, 0, 30, '0', 2)
	`

	return conversation
}

export async function seedNotification(prefix: string, overrides?: { title?: string; body?: string; read?: boolean }) {
	const sql = getSql()
	const [row] = await sql<{ id: string; title: string }[]>`
		insert into notifications (title, body, read)
		values (
			${overrides?.title ?? `${prefix} Notification`},
			${overrides?.body ?? `${prefix} notification body`},
			${overrides?.read ?? false}
		)
		returning id, title
	`
	return row
}

/* ────────────────────────────────────────────────────────────────────────────
 * CRUD-test helpers (added 2026-05-04)
 *
 * Used by tests/crud/*.crud.spec.ts to drive the full Create/Read/Update/Delete
 * lifecycle via the UI against real services. Existing helpers above are
 * untouched.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Returns the id of the singleton user. Single-user mode — there is exactly one row
 * (or none on a brand-new instance, in which case authenticateContext seeds it).
 */
export async function getActiveAdminUserId(): Promise<string> {
	const sql = getSql()
	const [u] = await sql<{ id: string }[]>`select id from users limit 1`
	if (!u) throw new Error('No user found for CRUD test')
	return u.id
}

export async function seedProject(
	prefix: string,
	overrides?: { name?: string; kind?: 'efoil' | 'research' | 'code' | 'documentation' | 'other'; description?: string },
) {
	const sql = getSql()
	const userId = await getActiveAdminUserId()
	const name = overrides?.name ?? `${prefix} Project`
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	const [row] = await sql<{ id: string; slug: string; name: string }[]>`
		insert into projects (user_id, name, slug, kind, description)
		values (${userId}, ${name}, ${slug}, ${overrides?.kind ?? 'other'}::project_kind, ${overrides?.description ?? ''})
		returning id, slug, name
	`
	return row
}

export async function seedSkill(
	prefix: string,
	overrides?: {
		name?: string
		description?: string
		content?: string
		enabled?: boolean
		tags?: string[]
		files?: Array<{ name: string; description?: string; content: string }>
	},
) {
	const sql = getSql()
	const name = overrides?.name ?? `${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-skill`
	const [row] = await sql<{ id: string; name: string }[]>`
		insert into skills (name, description, content, enabled, tags)
		values (
			${name},
			${overrides?.description ?? `${prefix} description`},
			${overrides?.content ?? `${prefix} content`},
			${overrides?.enabled ?? true},
			${sql.array(overrides?.tags ?? [])}
		)
		returning id, name
	`
	if (overrides?.files && overrides.files.length > 0) {
		for (const [i, file] of overrides.files.entries()) {
			await sql`
				insert into skill_files (skill_id, name, description, content, sort_order)
				values (${row.id}, ${file.name}, ${file.description ?? ''}, ${file.content}, ${i})
			`
		}
	}
	return row
}

export async function seedAutomation(
	prefix: string,
	agentId: string,
	overrides?: { prompt?: string; cron?: string; enabled?: boolean; conversationId?: string | null },
) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into automations (
			conversation_id, agent_id, prompt, cron_expression, enabled
		)
		values (
			${overrides?.conversationId ?? null},
			${agentId},
			${overrides?.prompt ?? `${prefix} automation prompt`},
			${overrides?.cron ?? '0 9 * * *'},
			${overrides?.enabled ?? true}
		)
		returning id
	`
	return row
}

export async function seedRepository(
	prefix: string,
	userId: string,
	overrides?: { owner?: string; name?: string; defaultBranch?: string; metadata?: Record<string, unknown> },
) {
	const sql = getSql()
	const owner = overrides?.owner ?? `${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-owner`
	const name = overrides?.name ?? `${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-repo`
	const meta = overrides?.metadata ?? {
		htmlUrl: `https://github.com/${owner}/${name}`,
		private: false,
		fork: false,
		archived: false,
	}
	const [row] = await sql<{ id: string; owner: string; name: string }[]>`
		insert into repositories (user_id, provider, owner, name, clone_url, default_branch, metadata)
		values (
			${userId},
			'github'::source_control_provider,
			${owner},
			${name},
			${`https://github.com/${owner}/${name}.git`},
			${overrides?.defaultBranch ?? 'main'},
			${JSON.stringify(meta)}::jsonb
		)
		returning id, owner, name
	`
	return row
}

/**
 * Inject a GitHub OAuth connection in the post-OAuth state. The encrypted_token
 * column is REAL (encrypted with the same key the runtime uses to decrypt). The
 * `accessToken` placeholder is intentionally a fake string; tests should not
 * trigger flows that actually call GitHub with it (covered by the user's
 * "token-injection only" decision).
 */
export async function seedGithubConnection(
	prefix: string,
	userId: string,
	overrides?: { providerAccount?: string; scopes?: string[]; accessToken?: string },
) {
	const sql = getSql()
	const account = overrides?.providerAccount ?? `${prefix.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}_user`
	// Use the same encryption helpers the runtime uses so the column round-trips.
	const { deriveKeyFromSecret, encryptWithKey } = await import('../src/lib/source-control/encryption')
	const secret = readEnvVar('APP_ENCRYPTION_KEY') ?? readEnvVar('CLAIM_KEY')
	if (!secret) throw new Error('seedGithubConnection requires APP_ENCRYPTION_KEY or CLAIM_KEY in .env')
	const encrypted = encryptWithKey(deriveKeyFromSecret(secret), overrides?.accessToken ?? 'gho_E2E_FAKE_TOKEN_DO_NOT_USE')
	const [row] = await sql<{ id: string; provider_account: string }[]>`
		insert into repository_connections (user_id, provider, provider_account, encrypted_token, scopes, status)
		values (
			${userId},
			'github'::source_control_provider,
			${account},
			${encrypted},
			${sql.array(overrides?.scopes ?? ['repo', 'read:user', 'read:org'])},
			'active'::source_control_connection_status
		)
		on conflict (user_id, provider, provider_account) do update set
			encrypted_token = excluded.encrypted_token,
			scopes = excluded.scopes,
			status = 'active'::source_control_connection_status,
			updated_at = now()
		returning id, provider_account
	`
	return { id: row.id, providerAccount: row.provider_account }
}

/**
 * Generic DB poller — runs `query()` every `intervalMs` until `predicate(value)`
 * returns true OR the timeout fires. Throws on timeout with the last value seen.
 */
export async function pollDb<T>(
	query: () => Promise<T>,
	predicate: (v: T) => boolean,
	opts?: { timeoutMs?: number; intervalMs?: number; description?: string },
): Promise<T> {
	const timeoutMs = opts?.timeoutMs ?? 15_000
	const intervalMs = opts?.intervalMs ?? 250
	const startedAt = Date.now()
	let last: T | undefined
	while (Date.now() - startedAt < timeoutMs) {
		last = await query()
		if (predicate(last)) return last
		await new Promise((r) => setTimeout(r, intervalMs))
	}
	throw new Error(
		`pollDb timed out after ${timeoutMs}ms${opts?.description ? ` (${opts.description})` : ''}: last value = ${JSON.stringify(last).slice(0, 400)}`,
	)
}

/**
 * Wraps a Playwright Page interaction with capture of any 5xx network responses
 * + page errors. If the wrapped fn throws, the failure message includes the
 * captured server errors so flaky timeouts surface their real cause.
 */
export async function withErrorCapture<T>(
	page: Page,
	fn: () => Promise<T>,
	opts?: { ignoreUrlPatterns?: RegExp[] },
): Promise<T> {
	const fiveXX: Array<{ url: string; status: number; body: string }> = []
	const consoleErrors: string[] = []
	const onResponse = async (resp: import('@playwright/test').Response) => {
		if (resp.status() < 500) return
		if (opts?.ignoreUrlPatterns?.some((re) => re.test(resp.url()))) return
		let body = ''
		try {
			body = await resp.text()
		} catch {
			body = '<no body>'
		}
		fiveXX.push({ url: resp.url(), status: resp.status(), body: body.slice(0, 500) })
	}
	const onPageError = (err: Error) => {
		consoleErrors.push(`pageerror: ${err.message}`)
	}
	const onConsole = (msg: import('@playwright/test').ConsoleMessage) => {
		if (msg.type() !== 'error') return
		const text = msg.text()
		if (/Failed to load resource.*404/.test(text)) return
		if (/favicon/.test(text)) return
		consoleErrors.push(`console.error: ${text}`)
	}
	page.on('response', onResponse)
	page.on('pageerror', onPageError)
	page.on('console', onConsole)
	try {
		return await fn()
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err)
		const extras = []
		if (fiveXX.length > 0) {
			extras.push(
				`\n  ${fiveXX.length} 5xx response(s):\n${fiveXX
					.map((r) => `    ${r.status} ${r.url}\n      body: ${r.body}`)
					.join('\n')}`,
			)
		}
		if (consoleErrors.length > 0) {
			extras.push(`\n  ${consoleErrors.length} console error(s):\n    ${consoleErrors.join('\n    ')}`)
		}
		throw new Error(`${errMsg}${extras.join('')}`)
	} finally {
		page.off('response', onResponse)
		page.off('pageerror', onPageError)
		page.off('console', onConsole)
	}
}

/**
 * Walks every visible element on the page and asserts none extend past the
 * viewport width. Catches "this content went off-screen on mobile" failures
 * that no-5xx smokes miss. Pass `ignoreSelectors` for elements that
 * intentionally horizontally scroll (e.g. <pre>, <table> inside .overflow-x-auto).
 */
export async function expectNoHorizontalOverflow(
	page: Page,
	opts?: { ignoreSelectors?: string[]; tolerancePx?: number },
): Promise<void> {
	const ignoreSelectors = opts?.ignoreSelectors ?? [
		'.overflow-x-auto *',
		'pre',
		'pre *',
		'code',
		'.modal',
		'.modal *',
		'[popover]',
		'[popover] *',
		'.popover',
		'.popover *',
	]
	const tolerance = opts?.tolerancePx ?? 1
	const offenders = await page.evaluate(
		({ ignore, tol }) => {
			const viewportWidth = window.innerWidth
			const matches = (el: Element) => ignore.some((sel) => el.matches(sel))
			const out: Array<{ selector: string; right: number; over: number; tag: string; text: string }> = []
			const all = Array.from(document.body.querySelectorAll<HTMLElement>('*'))
			for (const el of all) {
				if (el.offsetParent === null && el.tagName !== 'BODY') continue
				if (matches(el)) continue
				const rect = el.getBoundingClientRect()
				if (rect.width === 0 || rect.height === 0) continue
				if (rect.right > viewportWidth + tol) {
					// Build a selector hint
					let selector = el.tagName.toLowerCase()
					if (el.id) selector += `#${el.id}`
					else if (el.className && typeof el.className === 'string') {
						const cls = el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
						if (cls) selector += `.${cls}`
					}
					out.push({
						selector,
						right: Math.round(rect.right),
						over: Math.round(rect.right - viewportWidth),
						tag: el.tagName,
						text: (el.textContent ?? '').trim().slice(0, 60),
					})
				}
			}
			// De-dup parents that contain the offender via the same overflow.
			const dedup: typeof out = []
			for (const o of out) {
				const isParentOfExisting = dedup.some((d) => d.right === o.right && d.tag !== 'BODY' && d.tag !== 'HTML')
				if (!isParentOfExisting) dedup.push(o)
			}
			return { viewportWidth, offenders: dedup.slice(0, 10) }
		},
		{ ignore: ignoreSelectors, tol: tolerance },
	)
	if (offenders.offenders.length === 0) return
	const msg = offenders.offenders
		.map((o) => `  ${o.selector} (right=${o.right}px, +${o.over}px past viewport, "${o.text}")`)
		.join('\n')
	throw new Error(
		`${offenders.offenders.length} element(s) overflow viewport (${offenders.viewportWidth}px wide):\n${msg}`,
	)
}

/**
 * Convenience: fill multiple labeled inputs in one call. `fields` is a map of
 * accessible label text → value.
 */
export async function fillFormByLabel(page: Page, fields: Record<string, string>): Promise<void> {
	for (const [label, value] of Object.entries(fields)) {
		await page.getByLabel(label).fill(value)
	}
}

/**
 * Cleanup extension. Call this in finally blocks for CRUD specs that create
 * data across the new domains. Order matters — children before parents.
 */
export async function cleanupExtendedPrefix(prefix: string): Promise<void> {
	const sql = getSql()

	// Source-control rows
	if (await tableExists('repository_connections')) {
		await sql`delete from repository_connections where provider_account like ${`%${prefix.toLowerCase().replace(/[^a-z0-9_-]+/g, '_')}%`}`
	}
	if (await tableExists('repositories')) {
		await sql`delete from repositories where owner like ${`%${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}%`} or name like ${`%${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}%`}`
	}

	// Tasks (children → parents → attempts)
	if (await tableExists('tasks')) {
		await sql`delete from task_attempts where task_id in (select id from tasks where title like ${`${prefix}%`})`
		await sql`delete from tasks where title like ${`${prefix}%`} or spec like ${`${prefix}%`}`
	}

	// Projects + artifacts + versions
	if (await tableExists('artifact_versions')) {
		await sql`delete from artifact_versions where artifact_id in (select id from artifacts where name like ${`${prefix}%`})`
	}
	if (await tableExists('artifacts')) {
		await sql`delete from artifacts where name like ${`${prefix}%`}`
	}
	if (await tableExists('projects')) {
		await sql`delete from projects where name like ${`${prefix}%`}`
	}

	// Skills + files
	if (await tableExists('skill_files')) {
		await sql`delete from skill_files where skill_id in (select id from skills where name like ${`${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}%`} or name like ${`${prefix}%`})`
	}
	if (await tableExists('skills')) {
		await sql`delete from skills where name like ${`${prefix.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}%`} or description like ${`${prefix}%`}`
	}

	// Automations
	if (await tableExists('automations')) {
		await sql`delete from automations where prompt like ${`${prefix}%`}`
	}

	// Audit + review (created by cascading writes from the above)
	if (await tableExists('audit_events')) {
		await sql`delete from audit_events where summary like ${`${prefix}%`}`
	}
	if (await tableExists('review_items')) {
		await sql`delete from review_items where summary like ${`${prefix}%`}`
	}

	// Users — singleton enforcement means we never delete the lone user row from tests.

	// Then run the legacy cleanup for the older domains (agents/conversations/messages/etc).
	await cleanupPrefixedRecords(prefix)
}
