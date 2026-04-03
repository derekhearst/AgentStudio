import { json, type RequestHandler } from '@sveltejs/kit'
import { and, asc, eq, gt } from 'drizzle-orm'
import { db } from '$lib/server/db'
import { conversations, messages } from '$lib/server/db/schema'
import { streamChat, type LlmMessage } from '$lib/server/llm/openrouter'
import { extractAndPersist } from '$lib/server/memory/extract'
import { assembleContext } from '$lib/server/memory/context'
import { bumpAccessCount } from '$lib/server/memory/store'
import { generateTitle } from '$lib/server/chat/titlegen'

const encoder = new TextEncoder()

type StreamPayload = {
	conversationId: string
	content?: string
	model?: string
	regenerate?: boolean
}

function sse(name: string, payload: unknown) {
	return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
}

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as StreamPayload
	if (!body.conversationId) {
		return json({ error: 'conversationId is required' }, { status: 400 })
	}

	const [conversation] = await db.select().from(conversations).where(eq(conversations.id, body.conversationId)).limit(1)

	if (!conversation) {
		return json({ error: 'Conversation not found' }, { status: 404 })
	}

	const model = body.model ?? conversation.model
	let parentMessageId: string | null = null

	if (!body.regenerate) {
		if (!body.content || body.content.trim().length === 0) {
			return json({ error: 'content is required when regenerate=false' }, { status: 400 })
		}

		const [createdUser] = await db
			.insert(messages)
			.values({
				conversationId: body.conversationId,
				role: 'user',
				content: body.content.trim(),
				model,
				metadata: {},
				toolCalls: [],
			})
			.returning()

		parentMessageId = createdUser.id
	} else {
		const [lastUser] = await db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, body.conversationId), eq(messages.role, 'user')))
			.orderBy(messages.createdAt)
			.limit(1)
		parentMessageId = lastUser?.id ?? null
	}

	const historyRows = await db
		.select({ role: messages.role, content: messages.content })
		.from(messages)
		.where(eq(messages.conversationId, body.conversationId))
		.orderBy(asc(messages.createdAt))

	const isFirstExchange = historyRows.length === 0 && !body.regenerate

	const llmMessages: LlmMessage[] = historyRows
		.filter((row) => row.role === 'system' || row.role === 'user' || row.role === 'assistant')
		.map((row) => ({ role: row.role, content: row.content }))

	const memoryContext = await assembleContext(body.content ?? conversation.title)
	if (memoryContext.memories.length > 0) {
		llmMessages.unshift({
			role: 'system',
			content: memoryContext.systemPrompt,
		})
		await Promise.all(memoryContext.memories.map((memory) => bumpAccessCount(memory.id)))
	}

	const startedAt = Date.now()
	let firstTokenAt: number | null = null
	let assistantContent = ''
	let promptTokens = 0
	let completionTokens = 0

	const stream = await streamChat(llmMessages, model)

	const readable = new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const chunk of stream) {
					const delta = chunk.choices?.[0]?.delta as
						| {
								content?: string
								toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
						  }
						| undefined
					const content = delta?.content
					if (content) {
						if (firstTokenAt === null) {
							firstTokenAt = Date.now()
						}
						assistantContent += content
						controller.enqueue(sse('delta', { content }))
					}

					const toolCall = delta?.toolCalls?.[0]
					if (toolCall) {
						controller.enqueue(
							sse('tool_call', {
								id: toolCall.id ?? null,
								name: toolCall.function?.name ?? null,
								arguments: toolCall.function?.arguments ?? null,
							}),
						)
					}

					if (chunk.usage) {
						promptTokens = chunk.usage.promptTokens ?? promptTokens
						completionTokens = chunk.usage.completionTokens ?? completionTokens
					}
				}

				const totalMs = Date.now() - startedAt
				const ttftMs = firstTokenAt ? firstTokenAt - startedAt : null
				const tokensPerSec = totalMs > 0 ? Math.round((completionTokens / (totalMs / 1000)) * 100) / 100 : null

				const [assistantMessage] = await db
					.insert(messages)
					.values({
						conversationId: body.conversationId,
						role: 'assistant',
						content: assistantContent || '(no output)',
						model,
						parentMessageId,
						tokensIn: promptTokens,
						tokensOut: completionTokens,
						ttftMs,
						totalMs,
						tokensPerSec,
						cost: '0',
						metadata: {},
						toolCalls: [],
					})
					.returning()

				await db
					.update(conversations)
					.set({
						model,
						totalTokens: conversation.totalTokens + promptTokens + completionTokens,
						updatedAt: new Date(),
					})
					.where(eq(conversations.id, body.conversationId))

				if (isFirstExchange && body.content) {
					void generateTitle([
						{ role: 'user', content: body.content.trim() },
						{ role: 'assistant', content: assistantContent || '' },
					])
						.then((title) => db.update(conversations).set({ title }).where(eq(conversations.id, body.conversationId)))
						.catch(() => {
							// Non-critical — title stays as default
						})
				}

				const extractionMessages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }> = []
				if (!body.regenerate && body.content?.trim()) {
					extractionMessages.push({ role: 'user', content: body.content.trim() })
				}
				extractionMessages.push({ role: 'assistant', content: assistantContent || '(no output)' })
				void extractAndPersist(extractionMessages).catch(() => {
					// Ignore extraction failures to avoid impacting chat streaming.
				})

				controller.enqueue(
					sse('metrics', {
						model,
						tokensIn: promptTokens,
						tokensOut: completionTokens,
						ttftMs,
						totalMs,
						tokensPerSec,
						cost: 0,
					}),
				)
				controller.enqueue(sse('done', { messageId: assistantMessage.id }))
				controller.close()
			} catch (error) {
				controller.enqueue(
					sse('done', {
						error: error instanceof Error ? error.message : 'Failed to stream response',
					}),
				)
				controller.close()
			}
		},
	})

	return new Response(readable, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	})
}
