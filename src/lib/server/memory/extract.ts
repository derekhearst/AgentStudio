import { chat } from '$lib/server/llm/openrouter'
import { createMemory, createMemoryRelation, searchMemories } from '$lib/server/memory/store'
import { emitActivity } from '$lib/server/activity/emit'

type ConversationMessage = {
	role: 'user' | 'assistant' | 'system' | 'tool'
	content: string
}

type ExtractedMemory = {
	content: string
	category: string
	importance: number
}

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

	const response = await chat(
		[
			{ role: 'system', content: 'You extract durable user memory facts for an AI assistant.' },
			{ role: 'user', content: prompt },
		],
		'openai/gpt-4o-mini',
	)

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
