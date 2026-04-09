import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automation/automation.schema'
import { conversations, messages } from '$lib/chat/chat.schema'
import { agents } from '$lib/agents/agents.schema'
import { chat, type LlmMessage } from '$lib/openrouter.server'
import { logLlmUsage } from '$lib/cost/usage'
import { getOrCreateSettings } from '$lib/settings/settings.server'

function parseField(field: string, min: number, max: number) {
	if (field === '*') {
		const values: number[] = []
		for (let value = min; value <= max; value++) values.push(value)
		return values
	}

	if (/^\*\/[0-9]+$/.test(field)) {
		const step = Number(field.split('/')[1])
		if (!Number.isInteger(step) || step <= 0) return []
		const values: number[] = []
		for (let value = min; value <= max; value += step) values.push(value)
		return values
	}

	const parsed = Number(field)
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) return []
	return [parsed]
}

function normalizeCronExpression(cronExpression: string) {
	const normalized = cronExpression.trim().replace(/\s+/g, ' ')
	if (normalized === '@hourly') return '0 * * * *'
	if (normalized === '@daily') return '0 0 * * *'
	if (normalized === '@weekly') return '0 0 * * 1'
	return normalized
}

export function computeNextRunAt(cronExpression: string, from = new Date()) {
	const normalized = normalizeCronExpression(cronExpression)
	const parts = normalized.split(' ')
	if (parts.length !== 5) {
		throw new Error('Cron expression must have 5 fields: minute hour day-of-month month day-of-week')
	}

	const [minuteField, hourField, dayField, monthField, weekDayField] = parts
	const minutes = parseField(minuteField, 0, 59)
	const hours = parseField(hourField, 0, 23)
	const days = parseField(dayField, 1, 31)
	const months = parseField(monthField, 1, 12)
	const weekDays = parseField(weekDayField, 0, 6)
	if (minutes.length === 0 || hours.length === 0 || days.length === 0 || months.length === 0 || weekDays.length === 0) {
		throw new Error('Cron expression contains unsupported values')
	}

	const cursor = new Date(from)
	cursor.setSeconds(0, 0)
	cursor.setMinutes(cursor.getMinutes() + 1)

	for (let i = 0; i < 366 * 24 * 60; i++) {
		const minute = cursor.getMinutes()
		const hour = cursor.getHours()
		const day = cursor.getDate()
		const month = cursor.getMonth() + 1
		const weekDay = cursor.getDay()

		if (
			minutes.includes(minute) &&
			hours.includes(hour) &&
			days.includes(day) &&
			months.includes(month) &&
			weekDays.includes(weekDay)
		) {
			return new Date(cursor)
		}

		cursor.setMinutes(cursor.getMinutes() + 1)
	}

	throw new Error('Unable to compute next run time from cron expression')
}

async function getOrCreateAutomationConversation(automation: typeof automations.$inferSelect) {
	if (automation.conversationMode === 'reuse' && automation.conversationId) {
		const [existing] = await db
			.select()
			.from(conversations)
			.where(and(eq(conversations.id, automation.conversationId), eq(conversations.userId, automation.userId)))
			.limit(1)
		if (existing) return existing
	}

	const [created] = await db
		.insert(conversations)
		.values({
			title: automation.description,
			userId: automation.userId,
			agentId: automation.agentId ?? null,
			model: 'anthropic/claude-sonnet-4',
		})
		.returning()

	if (automation.conversationMode === 'reuse') {
		await db
			.update(automations)
			.set({ conversationId: created.id, updatedAt: new Date() })
			.where(eq(automations.id, automation.id))
	}

	return created
}

async function runAutomation(automation: typeof automations.$inferSelect, now: Date) {
	const conversation = await getOrCreateAutomationConversation(automation)
	const [agent] = automation.agentId
		? await db.select().from(agents).where(eq(agents.id, automation.agentId)).limit(1)
		: [null]
	const settings = await getOrCreateSettings(automation.userId)
	const model = agent?.model ?? settings.defaultModel

	const history = await db
		.select({ role: messages.role, content: messages.content })
		.from(messages)
		.where(eq(messages.conversationId, conversation.id))
		.orderBy(asc(messages.createdAt))
		.limit(12)

	const prompt = `Automation run at ${now.toISOString()}\n\n${automation.prompt}`
	await db.insert(messages).values({
		conversationId: conversation.id,
		role: 'user',
		content: prompt,
		model,
	})

	const llmMessages: LlmMessage[] = []
	if (agent?.systemPrompt?.trim()) {
		llmMessages.push({ role: 'system', content: agent.systemPrompt })
	}
	for (const item of history) {
		if (item.role === 'system' || item.role === 'user' || item.role === 'assistant') {
			llmMessages.push({ role: item.role, content: item.content })
		}
	}
	llmMessages.push({ role: 'user', content: prompt })

	const response = await chat(llmMessages, model)
	await db.insert(messages).values({
		conversationId: conversation.id,
		role: 'assistant',
		content: response.content,
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	})

	await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversation.id))

	void logLlmUsage({
		source: 'agent_synthesis',
		model,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	}).catch(() => {})

	return { conversationId: conversation.id }
}

export async function checkAndRunAutomations(now = new Date()) {
	const due = await db
		.select()
		.from(automations)
		.where(and(eq(automations.enabled, true), lte(automations.nextRunAt, now)))
		.orderBy(asc(automations.nextRunAt))
		.limit(25)

	const results: Array<{ automationId: string; ok: boolean; conversationId?: string; error?: string }> = []
	for (const automation of due) {
		try {
			const runResult = await runAutomation(automation, now)
			const nextRunAt = computeNextRunAt(automation.cronExpression, now)
			await db
				.update(automations)
				.set({
					lastRunAt: now,
					nextRunAt,
					updatedAt: now,
				})
				.where(eq(automations.id, automation.id))

			results.push({ automationId: automation.id, ok: true, conversationId: runResult.conversationId })
		} catch (error) {
			results.push({
				automationId: automation.id,
				ok: false,
				error: error instanceof Error ? error.message : 'Automation run failed',
			})
		}
	}

	return {
		runAt: now.toISOString(),
		evaluated: due.length,
		results,
	}
}
