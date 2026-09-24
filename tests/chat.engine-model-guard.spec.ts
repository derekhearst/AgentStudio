import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import * as devalue from 'devalue'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	readEnvVar,
	seedAgent,
	seedConversation,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { listRemoteFunctions } from './remote-functions'
import { isSubscriptionModel } from '../src/lib/engine/model-backend'

/**
 * #9 — picking a model nothing can run is impossible, not a failure on the first send.
 *
 * Without a gateway only Claude can run, and only the Claude models the bundled CLI knows.
 * The engine pickers list only those, labelled as running on the subscription; a send, an
 * agent save or a default-model save naming another model — or a Claude slug the CLI cannot
 * run — is refused before anything is written; and a conversation already on such a model
 * says so in the composer instead of waiting for the send to fail.
 *
 * All of this is the gateway-off posture, which is CI's. A developer whose .env configures a
 * gateway gets a different — correct — answer, so the file skips there.
 */

const gatewayConfigured = ['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN'].every(
	(name) => Boolean((process.env[name] ?? readEnvVar(name))?.trim()),
)
test.skip(gatewayConfigured, 'the test server has an LLM gateway configured, so non-Claude models can run')

const GATEWAY_MODEL = 'moonshotai/kimi-k2'
/** OpenRouter's slug for Claude Sonnet 4: `claude-sonnet-4` is no id the CLI or the API know. */
const STALE_CLAUDE_MODEL = 'anthropic/claude-sonnet-4'

const remotes = listRemoteFunctions()
function remote(file: string, name: string) {
	const fn = remotes.find((candidate) => candidate.file === file && candidate.name === name)
	if (!fn) throw new Error(`no remote function ${file}#${name}`)
	return fn
}

async function callCommand(page: Page, baseURL: string, file: string, name: string, pathname: string, arg: unknown) {
	const payload = Buffer.from(devalue.stringify(arg)).toString('base64url')
	const response = await page.request.post(`/_app/remote/${remote(file, name).id}`, {
		headers: { origin: baseURL, 'content-type': 'application/json', 'x-sveltekit-pathname': pathname },
		data: JSON.stringify({ payload, refreshes: [] }),
	})
	return (await response.json()) as { type: string; status?: number; error?: { message?: string } }
}

async function agentModel(agentId: string) {
	const [row] = await getSql()<{ model: string | null }[]>`select model from agents where id = ${agentId}`
	return row?.model ?? null
}

test('a send naming a model nothing can run is refused before the message or a run is saved', async ({ page }) => {
	const prefix = uniquePrefix('engine-model-send')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	try {
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const sql = getSql()
		const counts = async () => {
			const [row] = await sql<{ messages: number; runs: number }[]>`
				select
					(select count(*)::int from messages where conversation_id = ${conversation.id}) as messages,
					(select count(*)::int from chat_runs where conversation_id = ${conversation.id}) as runs
			`
			return row
		}
		const before = await counts()

		const response = await page.request.post(`/chat/${conversation.id}/stream`, {
			data: { conversationId: conversation.id, content: `${prefix} hello`, model: GATEWAY_MODEL },
		})
		expect(response.status()).toBe(400)
		const body = (await response.json()) as { error?: string }
		expect(body.error).toContain(GATEWAY_MODEL)
		expect(body.error).toContain('LLM_GATEWAY_URL')

		// A Claude slug the CLI cannot run is refused the same way, for its own reason — when it
		// is a pick. (The seed stores this very slug, and a send that only repeats a chat's stored,
		// retired model falls back to the default instead, so put the chat on a runnable one first.)
		await sql`update conversations set model = 'claude-sonnet-5' where id = ${conversation.id}`
		const stale = await page.request.post(`/chat/${conversation.id}/stream`, {
			data: { conversationId: conversation.id, content: `${prefix} hello`, model: STALE_CLAUDE_MODEL },
		})
		expect(stale.status()).toBe(400)
		const staleBody = (await stale.json()) as { error?: string }
		expect(staleBody.error).toContain(STALE_CLAUDE_MODEL)
		expect(staleBody.error).toContain('retired')

		// No orphan user message, no failed run: the refusal came before either was written.
		expect(await counts()).toEqual(before)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('an agent’s model: a change to an unrunnable model is refused, a dotted Claude id is stored as the CLI spells it', async ({
	page,
	baseURL,
}) => {
	const prefix = uniquePrefix('engine-model-agent')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const agent = await seedAgent(prefix)
	const sql = getSql()
	try {
		// A model stored before this rule, kept for the agent's automations.
		await sql`update agents set model = ${'deepseek/deepseek-chat'} where id = ${agent.id}`
		const file = 'src/lib/agents/agents.remote.ts'
		const pathname = `/agents/${agent.id}`
		// The dev server registers a remote file once a page using it has been compiled.
		await page.goto(pathname)
		await waitForHydration(page)

		// The editor resends every field; an unchanged legacy model must not block the edit.
		const unrelated = await callCommand(page, baseURL!, file, 'updateAgentCommand', pathname, {
			agentId: agent.id,
			systemPrompt: `${prefix} edited prompt`,
			model: 'deepseek/deepseek-chat',
		})
		expect(unrelated.type).toBe('result')

		const refused = await callCommand(page, baseURL!, file, 'updateAgentCommand', pathname, {
			agentId: agent.id,
			model: GATEWAY_MODEL,
		})
		expect(refused).toMatchObject({ type: 'error', status: 400 })
		expect(refused.error?.message).toContain('LLM_GATEWAY_URL')
		expect(await agentModel(agent.id)).toBe('deepseek/deepseek-chat')

		const claude = await callCommand(page, baseURL!, file, 'updateAgentCommand', pathname, {
			agentId: agent.id,
			model: 'anthropic/claude-haiku-4.5',
		})
		expect(claude.type).toBe('result')
		expect(await agentModel(agent.id)).toBe('claude-haiku-4-5')
	} finally {
		await sql`delete from audit_events where target_id = ${agent.id}`
		await cleanupPrefixedRecords(prefix)
	}
})

test('the update_agent tool is held to the agent editor’s rule', async () => {
	// The orchestrator's tool, served to the engine and the MCP endpoint alike. It used to
	// save any model it was given, and the agent's monitors then started conversations that
	// failed on every send.
	const prefix = uniquePrefix('engine-model-tool')
	await cleanupPrefixedRecords(prefix)
	const { agentAutomationHandlers } = await import('../src/lib/tools/handlers/agents-automations.server')
	const ctx = { userId: await getActiveUserId(), runId: null, startedAt: Date.now() }
	const agent = await seedAgent(prefix)
	const sql = getSql()
	const updateAgent = (args: Record<string, unknown>) =>
		agentAutomationHandlers.update_agent({ name: 'update_agent', arguments: { agentId: agent.id, ...args } }, ctx)
	const agentName = async () => (await sql<{ name: string }[]>`select name from agents where id = ${agent.id}`)[0]?.name
	try {
		await sql`update agents set model = ${'deepseek/deepseek-chat'} where id = ${agent.id}`

		// Resending the model it already has is not a change, so an unrelated edit goes through.
		const unrelated = await updateAgent({ role: `${prefix} new role`, model: 'deepseek/deepseek-chat' })
		expect(unrelated.success).toBe(true)

		for (const model of [GATEWAY_MODEL, STALE_CLAUDE_MODEL]) {
			const refused = await updateAgent({ name: `${prefix} renamed`, model })
			expect(refused.success, model).toBe(false)
			expect(refused.error, model).toContain(model)
		}
		// Refused whole: neither the model nor the rename in the same call was saved.
		expect(await agentModel(agent.id)).toBe('deepseek/deepseek-chat')
		expect(await agentName()).toBe(agent.name)

		const claude = await updateAgent({ model: 'anthropic/claude-haiku-4.5' })
		expect(claude.success).toBe(true)
		expect(await agentModel(agent.id)).toBe('claude-haiku-4-5')

		const missing = await agentAutomationHandlers.update_agent(
			{ name: 'update_agent', arguments: { agentId: randomUUID(), model: 'claude-sonnet-5' } },
			ctx,
		)
		expect(missing.success).toBe(false)
		expect(missing.error).toMatch(/not found/i)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('the default model cannot be set to one nothing can run', async ({ page, baseURL }) => {
	await authenticateContext(page.context())
	const userId = await getActiveUserId()
	const sql = getSql()
	const defaultModel = async () =>
		(await sql<{ default_model: string }[]>`select default_model from app_settings where user_id = ${userId}`)[0]
			?.default_model ?? null

	await page.goto('/settings')
	await waitForHydration(page)
	const before = await defaultModel()

	const refused = await callCommand(page, baseURL!, 'src/lib/settings/settings.remote.ts', 'updateAppSettings', '/settings', {
		defaultModel: GATEWAY_MODEL,
	})
	expect(refused).toMatchObject({ type: 'error', status: 400 })
	expect(refused.error?.message).toContain('LLM_GATEWAY_URL')
	expect(await defaultModel()).toBe(before)

	const stale = await callCommand(page, baseURL!, 'src/lib/settings/settings.remote.ts', 'updateAppSettings', '/settings', {
		defaultModel: STALE_CLAUDE_MODEL,
	})
	expect(stale).toMatchObject({ type: 'error', status: 400 })
	expect(stale.error?.message).toContain('retired')
	expect(await defaultModel()).toBe(before)
})

test('the engine model list offers only Claude, on the subscription, in the CLI’s spelling', async ({ page }) => {
	await authenticateContext(page.context())
	await page.goto('/settings')
	await waitForHydration(page)

	const fn = remote('src/lib/llm/models.remote.ts', 'getEngineModels')
	const response = await page.request.get(`/_app/remote/${fn.id}`, { headers: { 'x-sveltekit-pathname': '/settings' } })
	const body = (await response.json()) as { type: string; data: string }
	expect(body.type).toBe('result')
	// A remote function's answer is devalue-encoded, with the handler's return value under `_`.
	const list = (devalue.parse(body.data) as { _: unknown })._ as {
		gatewayConfigured: boolean
		models: Array<{ id: string; backend: string }>
	}

	expect(list.gatewayConfigured).toBe(false)
	// The saved default is always offered, so the list is never empty even if the
	// catalogue is unreachable.
	expect(list.models.length).toBeGreaterThan(0)
	for (const model of list.models) {
		expect(model.backend, model.id).toBe('subscription')
		expect(model.id, 'a bare CLI id').not.toContain('/')
		expect(model.id, 'versions written with a dash').not.toMatch(/\d\.\d/)
		expect(model.id, 'no catalogue variants').not.toContain(':')
		// Only a model the CLI can run: OpenRouter's catalogue still lists `anthropic/claude-sonnet-4`
		// and `anthropic/claude-3-haiku`, which would fail on the first message.
		expect(isSubscriptionModel(model.id), `${model.id} runs on the subscription`).toBe(true)
	}
	expect(list.models.map((model) => model.id)).not.toContain('claude-sonnet-4')
})

test('the default-model picker labels each model as running on the subscription', async ({ page }) => {
	await authenticateContext(page.context())
	await page.goto('/settings')
	await waitForHydration(page)

	// The Model & AI panel is the settings page's first section; its first row is the default.
	const row = page.getByText('Default Model', { exact: true }).filter({ visible: true }).first()
	await expect(row).toBeVisible()
	await row.locator('xpath=ancestor::div[contains(@class,"justify-between")][1]').getByRole('button').first().click()

	const note = page.getByTestId('engine-model-note')
	await expect(note).toBeVisible()
	await expect(note).toContainText('Claude models only')
	await expect(note).toContainText('LLM_GATEWAY_URL')

	const cards = page.locator('.modal [data-backend]')
	await expect(cards.first()).toBeVisible()
	const backends = await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-backend')))
	expect(new Set(backends)).toEqual(new Set(['subscription']))

	const first = cards.first()
	await expect(first.getByText('Subscription', { exact: true })).toBeVisible()
	await expect(first.getByText('Included', { exact: true })).toBeVisible()
	// The model's name must keep real width beside the labels on a phone.
	const nameBox = await first.locator('span.font-semibold').boundingBox()
	expect(nameBox?.width ?? 0).toBeGreaterThan(40)
})

test('a conversation already on an unrunnable model says so in the composer, and reasoning is off', async ({ page }) => {
	const prefix = uniquePrefix('engine-model-composer')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	try {
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		await getSql()`update conversations set model = ${GATEWAY_MODEL} where id = ${conversation.id}`

		await page.goto(`/chat/${conversation.id}`)
		await waitForHydration(page)

		const badge = page.getByText('Unavailable', { exact: true }).filter({ visible: true }).first()
		await expect(badge).toBeVisible()
		await expect(badge).toHaveAttribute('title', /gateway/i)
		const box = await badge.boundingBox()
		expect(box?.width ?? 0).toBeGreaterThan(0)

		const reasoning = page.getByRole('button', { name: 'Reasoning effort' }).filter({ visible: true }).first()
		await expect(reasoning).toBeDisabled()
		await expect(reasoning).toContainText('reasoning:off')
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('a send the server refuses leaves no bubble behind as if it had been sent', async ({ page }) => {
	const prefix = uniquePrefix('engine-model-bubble')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	try {
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		await getSql()`update conversations set model = ${GATEWAY_MODEL} where id = ${conversation.id}`

		await page.goto(`/chat/${conversation.id}`)
		await waitForHydration(page)

		const text = `${prefix} refused send`
		const composer = page.getByPlaceholder('Message AgentStudio...')
		await composer.waitFor({ state: 'visible', timeout: 30_000 })
		await composer.fill(text)
		const refusal = page.waitForResponse((response) => response.url().endsWith(`/chat/${conversation.id}/stream`))
		await page.getByRole('button', { name: /send message/i }).filter({ visible: true }).first().click()
		expect((await refusal).status()).toBe(400)

		// The refusal is shown, with Retry — which still carries the text.
		await expect(page.getByText(/LLM_GATEWAY_URL/).first()).toBeVisible({ timeout: 15_000 })
		await expect(page.getByRole('button', { name: /retry/i }).filter({ visible: true }).first()).toBeVisible()
		// Nothing was saved, so nothing stands in the transcript as if it had been sent.
		await expect(page.getByText(text, { exact: true })).toHaveCount(0)
		const [row] = await getSql()<{ count: number }[]>`
			select count(*)::int as count from messages where conversation_id = ${conversation.id} and content = ${text}
		`
		expect(row.count).toBe(0)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})
