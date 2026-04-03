import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '$lib/server/db'
import { conversations, dreamCycles, memories, messages } from '$lib/server/db/schema'
import { extractAndPersist } from '$lib/server/memory/extract'
import { pruneMemories, decayMemories } from '$lib/server/memory/store'
import { generateTitleAndCategory } from '$lib/server/chat/titlegen'

type DreamConfig = {
	decayLambda: number
	pruneThreshold: number
	topCount: number
	conversationLimit: number
	lookbackHours: number
}

const DEFAULT_DREAM_CONFIG: DreamConfig = {
	decayLambda: 0.03,
	pruneThreshold: 0.08,
	topCount: 24,
	conversationLimit: 12,
	lookbackHours: 72,
}

export async function categorizeConversations(conversationIds: string[]) {
	let categorized = 0
	for (const id of conversationIds) {
		try {
			const msgs = await db
				.select({ role: messages.role, content: messages.content })
				.from(messages)
				.where(eq(messages.conversationId, id))
				.orderBy(desc(messages.createdAt))
				.limit(10)

			const userAssistant = msgs.reverse().filter((m) => m.role === 'user' || m.role === 'assistant') as Array<{
				role: 'user' | 'assistant'
				content: string
			}>

			if (userAssistant.length === 0) continue

			const { title, category } = await generateTitleAndCategory(userAssistant)
			await db.update(conversations).set({ title, category }).where(eq(conversations.id, id))
			categorized++
		} catch {
			// Non-critical — skip this conversation
		}
	}
	return categorized
}

export async function condenseMemories(config: Partial<DreamConfig> = {}) {
	const merged = { ...DEFAULT_DREAM_CONFIG, ...config }
	const lookbackAt = new Date(Date.now() - merged.lookbackHours * 60 * 60 * 1000)

	const recentConversations = await db
		.select({ id: conversations.id })
		.from(conversations)
		.where(gte(conversations.updatedAt, lookbackAt))
		.orderBy(desc(conversations.updatedAt))
		.limit(merged.conversationLimit)

	let extractedCount = 0
	for (const conversation of recentConversations) {
		const history = await db
			.select({ role: messages.role, content: messages.content })
			.from(messages)
			.where(and(eq(messages.conversationId, conversation.id), gte(messages.createdAt, lookbackAt)))
			.orderBy(desc(messages.createdAt))
			.limit(20)

		const created = await extractAndPersist(
			history.reverse().map((message) => ({
				role: message.role,
				content: message.content,
			})),
		)
		extractedCount += created.length
	}

	await decayMemories(merged.decayLambda)
	const prunedCount = await pruneMemories(merged.pruneThreshold)

	const top = await db
		.select()
		.from(memories)
		.orderBy(desc(memories.importance), desc(memories.updatedAt))
		.limit(merged.topCount)

	return {
		recentConversationsProcessed: recentConversations.length,
		recentConversationIds: recentConversations.map((c) => c.id),
		extractedCount,
		prunedCount,
		top,
		config: merged,
	}
}

export async function runDreamCycle(config: Partial<DreamConfig> = {}) {
	const startedAt = new Date()
	const [cycle] = await db
		.insert(dreamCycles)
		.values({
			startedAt,
			memoriesProcessed: 0,
			memoriesCreated: 0,
			memoriesPruned: 0,
			summary: null,
		})
		.returning()

	const result = await condenseMemories(config)
	const categorizedCount = await categorizeConversations(result.recentConversationIds)
	const endedAt = new Date()
	const summary = `Processed ${result.recentConversationsProcessed} conversations, extracted ${result.extractedCount} memories, pruned ${result.prunedCount}, categorized ${categorizedCount} conversations.`

	await db
		.update(dreamCycles)
		.set({
			endedAt,
			memoriesProcessed: result.top.length,
			memoriesCreated: result.extractedCount,
			memoriesPruned: result.prunedCount,
			summary,
		})
		.where(eq(dreamCycles.id, cycle.id))

	return {
		ok: true,
		cycleId: cycle.id,
		startedAt,
		endedAt,
		durationMs: endedAt.getTime() - startedAt.getTime(),
		summary,
		...result,
	}
}

export async function listDreamCycles(limit = 20) {
	return db
		.select()
		.from(dreamCycles)
		.orderBy(desc(dreamCycles.startedAt))
		.limit(Math.max(1, Math.min(100, limit)))
}
