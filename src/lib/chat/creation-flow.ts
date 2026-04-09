import { goto } from '$app/navigation'
import { createConversation } from '$lib/chat'

export type CreationKind = 'agent' | 'skill'

type GuidedCreationInput = {
	kind: CreationKind
	model?: string
	context?: Record<string, string | undefined>
}

function buildPrompt({ kind, context = {} }: GuidedCreationInput) {
	const commonRules = [
		'Help me create this using a cooperative planning flow.',
		'First ask clarifying questions one at a time if needed, using ask_user when options are helpful.',
		'Do not execute any tool calls until I approve the final plan card.',
		'When ready, present a concise execution plan for approval.',
		'After approval, execute only the approved plan and summarize what was created.',
	]

	const contextLine = Object.entries(context)
		.filter(([, value]) => Boolean(value?.trim()))
		.map(([key, value]) => `${key}: ${value}`)
		.join('; ')

	const scopedContext = contextLine ? `Use this provided context: ${contextLine}.` : ''

	if (kind === 'agent') {
		return [
			'Create a new agent for me.',
			...commonRules,
			'Gather name, role, model, and system prompt preferences before producing the execution plan.',
			scopedContext,
		].join(' ')
	}

	return [
		'Create a new reusable skill for me.',
		...commonRules,
		'Gather skill name, description, tags, and main markdown content goals before proposing execution.',
		scopedContext,
	].join(' ')
}

export async function startGuidedCreationChat(input: GuidedCreationInput) {
	const prompt = buildPrompt(input)
	const title = `Create ${input.kind}`
	const created = await createConversation({ title, model: input.model })
	await goto(`/chat/${created.id}?prompt=${encodeURIComponent(prompt)}`)
}
