import { z } from 'zod'
import { chat, type ResponseFormat } from '$lib/llm/chat.server'
import { logLlmUsage } from '$lib/costs/usage'

type Message = { role: 'user' | 'assistant'; content: string }

export async function generateTitle(messages: Message[]): Promise<string> {
	const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n')

	const titleModel = 'openai/gpt-4o-mini'
	const response = await chat(
		[
			{
				role: 'system',
				content:
					'You generate short, descriptive conversation titles. Respond with only the title, no punctuation at the end, no quotes.',
			},
			{
				role: 'user',
				content: `Write a concise 3-8 word title for this conversation:\n\n${transcript}`,
			},
		],
		titleModel,
		{ cache: { enabled: true, ttlSeconds: 3600 } },
	)

	void logLlmUsage({
		source: 'titlegen',
		model: titleModel,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	}).catch(() => {})

	const title = (response.content ?? '')
		.trim()
		.replace(/^["']|["']$/g, '')
		.slice(0, 120)
	return title || 'Untitled conversation'
}

const titleCategorySchema = z.object({
	title: z.string().max(120),
	category: z.string().max(60),
})

const titleCategoryResponseFormat: ResponseFormat = {
	type: 'json_schema',
	json_schema: {
		name: 'conversation_label',
		strict: true,
		schema: z.toJSONSchema(titleCategorySchema) as Record<string, unknown>,
	},
}

export async function generateTitleAndCategory(messages: Message[]): Promise<{ title: string; category: string }> {
	const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n')

	const catModel = 'openai/gpt-4o-mini'
	const response = await chat(
		[
			{
				role: 'system',
				content:
					'You label conversations with a short title and a freeform category. Respond with valid JSON only: {"title":"...","category":"..."}. The title should be 3-8 words. The category should be 1-3 words that best describes the topic. No wrapping text, no markdown.',
			},
			{
				role: 'user',
				content: `Label this conversation:\n\n${transcript}`,
			},
		],
		catModel,
		{ responseFormat: titleCategoryResponseFormat, cache: { enabled: true, ttlSeconds: 3600 } },
	)

	void logLlmUsage({
		source: 'titlegen',
		model: catModel,
		tokensIn: response.usage?.promptTokens ?? 0,
		tokensOut: response.usage?.completionTokens ?? 0,
	}).catch(() => {})

	try {
		const raw = response.content
			.trim()
			.replace(/^```json\s*|^```\s*|```$/g, '')
			.trim()
		const parsed = JSON.parse(raw) as { title?: string; category?: string }
		return {
			title: (parsed.title ?? '').trim().slice(0, 120) || 'Untitled conversation',
			category: (parsed.category ?? '').trim().toLowerCase().slice(0, 60) || 'general',
		}
	} catch {
		return { title: 'Untitled conversation', category: 'general' }
	}
}
