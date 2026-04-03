import { env } from '$env/dynamic/private'
import { chat } from '$lib/server/llm/openrouter'

const MOCK_EXTERNALS = env.E2E_MOCK_EXTERNALS === '1'

type Message = { role: 'user' | 'assistant'; content: string }

export async function generateTitle(messages: Message[]): Promise<string> {
	if (MOCK_EXTERNALS) {
		return 'Mock conversation'
	}

	const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n')

	const response = await chat(
		[
			{
				role: 'system',
				content:
					'You generate short, descriptive conversation titles. Respond with only the title, no punctuation at the end, no quotes.',
			},
			{
				role: 'user',
				content: `Write a concise 3–8 word title for this conversation:\n\n${transcript}`,
			},
		],
		'openai/gpt-4o-mini',
	)

	const title = (response.content ?? '')
		.trim()
		.replace(/^["']|["']$/g, '')
		.slice(0, 120)
	return title || 'Untitled conversation'
}

export async function generateTitleAndCategory(messages: Message[]): Promise<{ title: string; category: string }> {
	if (MOCK_EXTERNALS) {
		return { title: 'Mock conversation', category: 'general' }
	}

	const transcript = messages.map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 400)}`).join('\n')

	const response = await chat(
		[
			{
				role: 'system',
				content:
					'You label conversations with a short title and a freeform category. Respond with valid JSON only: {"title":"...","category":"..."}. The title should be 3–8 words. The category should be 1–3 words that best describes the topic. No wrapping text, no markdown.',
			},
			{
				role: 'user',
				content: `Label this conversation:\n\n${transcript}`,
			},
		],
		'openai/gpt-4o-mini',
	)

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
