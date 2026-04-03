import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'

type ParsedEnv = {
	AUTH_PASSWORD: string
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

	const AUTH_PASSWORD = values.get('AUTH_PASSWORD')
	const DATABASE_URL = values.get('DATABASE_URL')
	if (!AUTH_PASSWORD || !DATABASE_URL) {
		throw new Error('AUTH_PASSWORD and DATABASE_URL must exist in .env for Playwright tests')
	}

	cachedEnv = { AUTH_PASSWORD, DATABASE_URL }
	return cachedEnv
}

export function readEnvVar(name: string) {
	parseEnvFile()
	return cachedEnvValues?.get(name)
}

export function uniquePrefix(scope: string) {
	return `E2E:${scope}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

function createSessionToken(secret: string) {
	const nonce = randomBytes(32).toString('base64url')
	const signature = createHmac('sha256', secret).update(nonce).digest('base64url')
	return `${nonce}.${signature}`
}

export async function authenticateContext(context: BrowserContext) {
	const { AUTH_PASSWORD } = parseEnvFile()
	const token = createSessionToken(AUTH_PASSWORD)
	await context.addCookies([
		{
			name: 'drokbot_session',
			value: token,
			url: 'http://127.0.0.1:4173',
			httpOnly: true,
			sameSite: 'Lax',
			secure: false,
		},
	])
}

export async function loginViaUi(page: Page) {
	const { AUTH_PASSWORD } = parseEnvFile()
	await page.goto('/login')
	await page.getByLabel('Password').fill(AUTH_PASSWORD)
	await page.getByRole('button', { name: /sign in/i }).click()
}

export function getSql() {
	if (!sqlClient) {
		const { DATABASE_URL } = parseEnvFile()
		sqlClient = postgres(DATABASE_URL, { max: 1 })
	}
	return sqlClient
}

export async function cleanupPrefixedRecords(prefix: string) {
	const sql = getSql()

	await sql`delete from agent_runs where task_id in (select id from agent_tasks where title like ${`${prefix}%`})`
	await sql`delete from agent_tasks where title like ${`${prefix}%`} or description like ${`${prefix}%`}`
	await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
	await sql`delete from conversations where title like ${`${prefix}%`}`
	await sql`delete from memory_relations where source_memory_id in (select id from memories where content like ${`${prefix}%`}) or target_memory_id in (select id from memories where content like ${`${prefix}%`})`
	await sql`delete from memories where content like ${`${prefix}%`} or category like ${`${prefix}%`}`
	await sql`delete from notifications where title like ${`${prefix}%`} or body like ${`${prefix}%`}`
	await sql`delete from push_subscriptions where device_label like ${`${prefix}%`}`
	await sql`delete from agents where name like ${`${prefix}%`} or role like ${`${prefix}%`}`
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

export async function seedConversation(
	prefix: string,
	overrides?: { title?: string; userMessage?: string; assistantMessage?: string },
) {
	const sql = getSql()
	const [conversation] = await sql<{ id: string; title: string }[]>`
		insert into conversations (title, model, total_tokens, total_cost)
		values (${overrides?.title ?? `${prefix} Conversation`}, ${'anthropic/claude-sonnet-4'}, 42, '0')
		returning id, title
	`

	await sql`
		insert into messages (conversation_id, role, content, metadata, tool_calls, tokens_in, tokens_out, cost)
		values
			(${conversation.id}, ${'user'}, ${overrides?.userMessage ?? `${prefix} user message`}, '{}'::jsonb, '[]'::jsonb, 12, 0, '0'),
			(${conversation.id}, ${'assistant'}, ${overrides?.assistantMessage ?? `${prefix} assistant reply`}, '{}'::jsonb, '[]'::jsonb, 0, 30, '0')
	`

	return conversation
}

export async function seedMemory(
	prefix: string,
	overrides?: { content?: string; category?: string; importance?: number },
) {
	const sql = getSql()
	const [row] = await sql<{ id: string; content: string }[]>`
		insert into memories (content, category, importance, updated_at)
		values (
			${overrides?.content ?? `${prefix} memory content`},
			${overrides?.category ?? 'general'},
			${overrides?.importance ?? 0.6},
			now()
		)
		returning id, content
	`
	return row
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
