import { and, desc, eq, gte } from 'drizzle-orm'
import { chat } from '$lib/openrouter.server'
import { db } from '$lib/db.server'
import { conversations, messages } from '$lib/chat/chat.schema'
import { generateTitleAndCategory } from '$lib/chat/chat'
import { logLlmUsage } from '$lib/cost/usage'
import { dreamCycles, memories } from '$lib/memory/memory.schema'
import {
	bumpAccessCount,
	createMemory,
	createMemoryRelation,
	decayMemories,
	listMemories,
	pruneMemories,
	searchMemories,
} from '$lib/memory/memory.server'
import { emitActivity } from '$lib/activity/activity.server'

type ConversationMessage = {
	role: 'user' | 'assistant' | 'system' | 'tool'
	content: string
}

type ExtractedMemory = {
	content: string
	category: string
	importance: number
}

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

const GREETING_PATTERN =
	/^(h(i|ey|ello|owdy)|yo|sup|what'?s\s*up|good\s*(morning|evening|afternoon)|thanks?|ok|yes|no|gm)\b/i
const TRIVIAL_MAX_LENGTH = 20

export async function extractFromConversation(messages: ConversationMessage[]) {
	if (messages.length === 0) return []

	const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n')
	const prompt = [
		'Extract concise durable memory facts from this transcript.',
		'Return JSON array of objects with keys: content, category, importance (0-1).',
		'Focus on user preferences, explicit decisions, and repeated patterns.',
		'If nothing useful, return [].',
		`Transcript:\n${transcript}`,
	].join('\n\n')

	const extractModel = 'openai/gpt-4o-mini'
	const response = await chat(
		[
			{ role: 'system', content: 'You extract durable user memory facts for an AI assistant.' },
			{ role: 'user', content: prompt },
		],
		extractModel,
	)

	void logLlmUsage({
		source: 'memory_extract',
		model: extractModel,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	}).catch(() => {})

	try {
		const parsed = JSON.parse(response.content) as ExtractedMemory[]
		return parsed
			.filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
			.map((item) => ({
				content: item.content.trim(),
				category: item.category || 'general',
				importance: Math.max(0, Math.min(1, Number(item.importance ?? 0.5))),
			}))
	} catch {
		return []
	}
}

export async function deduplicateMemories(candidates: ExtractedMemory[]) {
	const unique: ExtractedMemory[] = []
	const seen = new Set<string>()
	for (const candidate of candidates) {
		const key = candidate.content.toLowerCase().replace(/\s+/g, ' ').trim()
		if (seen.has(key)) {
			continue
		}
		const matches = await searchMemories(candidate.content, 3)
		const hasVeryClose = matches.some((match) => match.content.toLowerCase() === candidate.content.toLowerCase())
		if (!hasVeryClose) {
			unique.push(candidate)
			seen.add(key)
		}
	}
	return unique
}

function normalizeForNegation(text: string) {
	return text
		.toLowerCase()
		.replace(/[.!?]/g, '')
		.replace(/^not\s+/, '')
		.trim()
}

function isContradiction(a: string, b: string) {
	const normalizedA = a.toLowerCase().trim()
	const normalizedB = b.toLowerCase().trim()
	const strippedA = normalizeForNegation(a)
	const strippedB = normalizeForNegation(b)
	const aNegated = normalizedA.startsWith('not ')
	const bNegated = normalizedB.startsWith('not ')

	return strippedA.length > 0 && strippedA === strippedB && aNegated !== bNegated
}

function overlapScore(a: string, b: string) {
	const tokenize = (value: string) =>
		new Set(
			value
				.toLowerCase()
				.replace(/[^a-z0-9\s]/g, ' ')
				.split(/\s+/)
				.filter((token) => token.length > 2),
		)

	const aTokens = tokenize(a)
	const bTokens = tokenize(b)
	if (aTokens.size === 0 || bTokens.size === 0) return 0

	let intersection = 0
	for (const token of aTokens) {
		if (bTokens.has(token)) {
			intersection += 1
		}
	}

	return intersection / Math.max(aTokens.size, bTokens.size)
}

export async function createRelations(memoryId: string, content: string, importance: number) {
	const neighbors = await searchMemories(content, 6)
	let created = 0

	for (const neighbor of neighbors) {
		if (neighbor.id === memoryId) continue

		if (isContradiction(content, neighbor.content)) {
			await createMemoryRelation(memoryId, neighbor.id, 'contradicts', Math.max(0.4, importance))
			created += 1
			continue
		}

		const score = overlapScore(content, neighbor.content)
		if (score >= 0.45) {
			await createMemoryRelation(memoryId, neighbor.id, 'supports', Math.max(0.2, Math.min(1, score)))
			created += 1
		}
	}

	return {
		memoryId,
		created,
	}
}

export async function extractAndPersist(messages: ConversationMessage[]) {
	const extracted = await extractFromConversation(messages)
	const unique = await deduplicateMemories(extracted)
	const created = []
	for (const memory of unique) {
		const row = await createMemory(memory.content, memory.category, memory.importance)
		await createRelations(row.id, row.content, row.importance)
		created.push(row)
		void emitActivity('memory_created', `Memory extracted: ${memory.content.slice(0, 100)}`, {
			entityId: row.id,
			entityType: 'memory',
			metadata: { category: memory.category, importance: memory.importance },
		})
	}
	return created
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
			// Non-critical: skip failed conversation categorization.
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

export async function buildImportPrompt(options?: { includeExisting?: boolean }) {
	let existingContext = ''

	if (options?.includeExisting) {
		const existing = await listMemories({ limit: 200 })
		if (existing.length > 0) {
			const categoryCounts = new Map<string, number>()
			for (const m of existing) {
				categoryCounts.set(m.category, (categoryCounts.get(m.category) ?? 0) + 1)
			}
			const summary = [...categoryCounts.entries()].map(([cat, count]) => `${cat}: ${count}`).join(', ')

			existingContext = [
				'',
				'I already have these memory categories stored: ' + summary + '.',
				'Skip facts I likely already know and focus on new or unique information.',
			].join('\n')
		}
	}

	return [
		'I use a personal AI assistant that stores long-term memories about me.',
		'Please help me transfer knowledge from our conversations here into my assistant.',
		'',
		'List everything you know about me as concise, standalone facts - one fact per line.',
		'Cover these categories:',
		'- **preference** - likes, dislikes, communication style, tools I prefer',
		"- **project** - things I'm working on, tech stack, goals",
		"- **person** - people I've mentioned, relationships, roles",
		"- **constraint** - limitations, deadlines, requirements I've stated",
		'- **general** - anything else noteworthy',
		'',
		'Format each fact as a single clear sentence. Do not use bullet markers or numbering.',
		'Do not include uncertain or speculative information.',
		'Do not include facts about yourself or our conversation mechanics.',
		existingContext,
	]
		.join('\n')
		.trim()
}

export async function extractFromImportText(text: string, model?: string) {
	if (!text.trim()) return { imported: 0, memories: [] }

	const response = await chat(
		[
			{
				role: 'system',
				content: [
					'You parse user-provided text into structured memory facts for an AI assistant.',
					'Return a JSON array of objects with keys: content (string), category (string), importance (number 0-1).',
					'Valid categories: general, preference, project, person, constraint.',
					'Set importance based on how durable/significant the fact is (0.3 for trivial, 0.5 for normal, 0.7+ for key identity/project facts).',
					'Each memory should be a single concise sentence.',
					'If the input contains no useful facts, return [].',
				].join('\n'),
			},
			{
				role: 'user',
				content: ['Parse the following text into individual memory facts.\n', text].join('\n'),
			},
		],
		model ?? 'openai/gpt-4o-mini',
	)

	let extracted: Array<{ content: string; category: string; importance: number }>
	try {
		const raw = response.content.replace(/^```json?\s*|```$/gm, '').trim()
		const parsed = JSON.parse(raw) as Array<{ content: string; category: string; importance: number }>
		extracted = parsed
			.filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
			.map((item) => ({
				content: item.content.trim(),
				category: ['general', 'preference', 'project', 'person', 'constraint'].includes(item.category)
					? item.category
					: 'general',
				importance: Math.max(0, Math.min(1, Number(item.importance ?? 0.5))),
			}))
	} catch {
		return { imported: 0, memories: [] }
	}

	const unique = await deduplicateMemories(extracted)
	const created: Array<{ content: string; category: string; importance: number }> = []

	for (const memory of unique) {
		const row = await createMemory(memory.content, memory.category, memory.importance)
		await createRelations(row.id, row.content, row.importance)
		created.push({ content: row.content, category: row.category, importance: row.importance })
		void emitActivity('memory_created', `Memory imported: ${memory.content.slice(0, 100)}`, {
			entityId: row.id,
			entityType: 'memory',
			metadata: { category: memory.category, importance: memory.importance, source: 'import' },
		})
	}

	return { imported: created.length, memories: created }
}

export function shouldFetchMemory(content: string): boolean {
	const trimmed = content.trim()
	if (trimmed.length <= TRIVIAL_MAX_LENGTH && GREETING_PATTERN.test(trimmed)) return false
	return true
}

export async function assembleContext(conversationTopic?: string, options?: { limit?: number }) {
	const query = conversationTopic?.trim() || 'user preferences and current project context'
	const limit = options?.limit ?? 8
	const memories = await searchMemories(query, limit)

	const bulletPoints = memories.map((memory, index) => `${index + 1}. [${memory.category}] ${memory.content}`)
	return {
		query,
		memories,
		systemPrompt: [
			'Relevant long-term memories for this conversation:',
			...bulletPoints,
			'Use these as soft constraints. Prefer newer facts when conflicts exist.',
		].join('\n'),
	}
}

export { bumpAccessCount }
