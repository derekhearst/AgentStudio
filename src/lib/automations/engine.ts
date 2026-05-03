import { and, asc, eq, lte } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { automations } from '$lib/automations/automation.schema'
import { conversations, messages } from '$lib/sessions/sessions.schema'
import { agents } from '$lib/agents/agents.schema'
import { chat, type LlmMessage } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'
import { getOrCreateSettings } from '$lib/settings/settings.server'
import { chatRuns } from '$lib/runs/runs.schema'
import { getToolDefinitions } from '$lib/tools/tools.server'
import { listSkillSummaries } from '$lib/skills/skills.server'
import { recallForUser, renderMemoryContext } from '$lib/memory/memory.server'
import { assembleSystemPrompt, type ContextSlot } from '$lib/context/slots.server'
import { createDetachedSession, runChatLoop } from '$lib/runtime'

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

/**
 * Wave 2 #10 phase 6 — when an agent is attached, the automation tick runs the FULL agent loop
 * (tool calls, multi-round, capability disclosure, durable run state) via the runtime + a
 * detached Session. Without an agent, we keep the legacy single-shot `chat()` synthesis path —
 * lighter, no wasted infra, no need for a chat_run row.
 */
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

	if (agent) {
		return runAutomationWithAgent({ automation, conversation, agent, history, prompt, model, now })
	}
	return runAutomationSynthesis({ automation, conversation, history, prompt, model, now })
}

async function runAutomationSynthesis(args: {
	automation: typeof automations.$inferSelect
	conversation: typeof conversations.$inferSelect
	history: Array<{ role: string; content: string }>
	prompt: string
	model: string
	now: Date
}) {
	const { automation, conversation, history, prompt, model, now } = args

	const llmMessages: LlmMessage[] = []
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
		userId: automation.userId,
		agentId: automation.agentId ?? null,
	}).catch(() => {})

	return { conversationId: conversation.id }
}

async function runAutomationWithAgent(args: {
	automation: typeof automations.$inferSelect
	conversation: typeof conversations.$inferSelect
	agent: typeof agents.$inferSelect
	history: Array<{ role: string; content: string }>
	prompt: string
	model: string
	now: Date
}) {
	const { automation, conversation, agent, history, prompt, model, now } = args

	// Resolve workspace context the same way the chat stream does.
	const agentConfigForWs = agent.config as
		| {
				allowedTools?: string[]
				capabilityGroups?: string[]
				workspace?: {
					mode?: string
					key?: string
					repoPath?: string
					baseBranch?: string
					deleteBranchOnCleanup?: boolean
				}
		  }
		| null
	const persistentKey =
		agentConfigForWs?.workspace?.mode === 'persistent' &&
		typeof agentConfigForWs.workspace.key === 'string' &&
		agentConfigForWs.workspace.key.length > 0
			? agentConfigForWs.workspace.key
			: null
	const worktreeConfig =
		agentConfigForWs?.workspace?.mode === 'worktree' &&
		typeof agentConfigForWs.workspace.repoPath === 'string' &&
		agentConfigForWs.workspace.repoPath.length > 0
			? {
					repoPath: agentConfigForWs.workspace.repoPath,
					baseBranch: agentConfigForWs.workspace.baseBranch,
					deleteBranchOnCleanup: agentConfigForWs.workspace.deleteBranchOnCleanup,
				}
			: null
	const scopedAgentTools = Array.isArray(agentConfigForWs?.allowedTools) && agentConfigForWs.allowedTools.length > 0
		? agentConfigForWs.allowedTools
		: null

	// Build the agent's slot-based system prompt — identity + role + tool policy + skills + memory.
	const slots: ContextSlot[] = [
		{ name: 'identity', priority: 100, content: agent.systemPrompt },
		{ name: 'role', priority: 95, content: `Your role: ${agent.role}` },
		{
			name: 'tool_policy',
			priority: 90,
			content: [
				'Automation policy:',
				'- This is a scheduled automation tick — there is no user to ask in real time.',
				'- Complete the work, then summarize what you did. If you need user input, leave a clear note for the next manual review.',
			].join('\n'),
		},
	]

	const skillSummaries = await listSkillSummaries()
	if (skillSummaries.length > 0) {
		const text = skillSummaries
			.map((s) => `- ${s.name}: ${s.description}`)
			.join('\n')
		slots.push({
			name: 'skills',
			priority: 70,
			content: `Available skills (use read_skill to load):\n${text}`,
			truncationStrategy: 'truncate-end',
		})
	}

	try {
		const recalled = await recallForUser(automation.userId, prompt, { topK: 5 })
		const memoryBlock = renderMemoryContext(recalled)
		if (memoryBlock) {
			slots.push({ name: 'memory', priority: 60, content: memoryBlock, truncationStrategy: 'truncate-end' })
		}
	} catch (err) {
		console.warn('[automation] memory recall failed', err)
	}

	const llmMessages: LlmMessage[] = [
		{ role: 'system', content: assembleSystemPrompt(slots).systemPrompt },
	]
	for (const item of history) {
		if (item.role === 'user' || item.role === 'assistant') {
			llmMessages.push({ role: item.role, content: item.content })
		}
	}
	llmMessages.push({ role: 'user', content: prompt })

	// Tool surface mirrors the agent path in the chat stream: scoped allow-list if set, else
	// "all tools minus ask_user" since automations have no user-facing approval surface.
	const allTools = getToolDefinitions().filter((t) => t.function.name !== 'ask_user')
	const tools = scopedAgentTools
		? allTools.filter((t) => scopedAgentTools.includes(t.function.name))
		: allTools

	const [run] = await db
		.insert(chatRuns)
		.values({
			conversationId: conversation.id,
			userId: automation.userId,
			agentId: agent.id,
			state: 'running',
			source: 'automation',
			label: `Automation tick: ${automation.description.slice(0, 80)}`,
			startedAt: now,
			lastHeartbeatAt: now,
		})
		.returning({ id: chatRuns.id })

	const session = createDetachedSession({ runId: run.id })

	try {
		const loopResult = await runChatLoop({
			session,
			userId: automation.userId,
			conversationId: conversation.id,
			model,
			initialMessages: llmMessages,
			initialTools: tools,
			computeTools: async () => tools,
			maxRounds: 10, // automations are bounded — no human in the loop to course-correct
			approvalRequiredTools: new Set<string>(), // no approval surface in a detached run
			isOrchestrator: false,
			persistentKey,
			worktree: worktreeConfig,
			spawnSubagent: undefined,
		})

		const cost = await logLlmUsage({
			source: 'automation',
			model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			userId: automation.userId,
			runId: run.id,
			agentId: agent.id,
			metadata: { conversationId: conversation.id, automationId: automation.id },
		}).catch(() => '0')

		await db.insert(messages).values({
			conversationId: conversation.id,
			role: 'assistant',
			content: loopResult.finalText || '(no output)',
			model,
			tokensIn: loopResult.promptTokens,
			tokensOut: loopResult.completionTokens,
			cost,
			toolCalls: loopResult.toolCalls,
			metadata: {
				blocks: loopResult.streamBlocks.length > 0 ? loopResult.streamBlocks : undefined,
				automationId: automation.id,
				runId: run.id,
			},
		})

		await db
			.update(conversations)
			.set({ updatedAt: now })
			.where(eq(conversations.id, conversation.id))

		await session.updateRun({
			state: 'completed',
			label: 'Automation completed',
			lastDelta: loopResult.finalText.slice(-500),
			heartbeat: true,
			finished: true,
		})

		return { conversationId: conversation.id, runId: run.id }
	} catch (error) {
		await session.updateRun({
			state: 'failed',
			label: 'Automation failed',
			error: error instanceof Error ? error.message : 'Automation run failed',
			finished: true,
		})
		throw error
	}
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
