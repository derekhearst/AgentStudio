import { goto } from '$app/navigation'
import { createConversation, getConversations } from '$lib/chat'

export type CreationKind = 'agent' | 'skill'

type GuidedCreationInput = {
	kind: CreationKind
	model?: string
	context?: Record<string, string | undefined>
}

function buildPrompt({ kind, context = {} }: GuidedCreationInput) {
	const commonRules = [
		'Help me create this using a cooperative execution flow.',
		'First ask clarifying questions one at a time if needed, using ask_user when options are helpful.',
		'Execute tool calls directly as needed once requirements are clear.',
		'If user input is missing, ask for it and then continue execution.',
		'Summarize what was created and any follow-up options.',
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
			'Gather name, role, model, and system prompt preferences before creating the agent.',
			scopedContext,
		].join(' ')
	}

	return [
		'Create a new reusable skill for me.',
		...commonRules,
		'Gather skill name, description, tags, and main markdown content goals before creating files.',
		scopedContext,
	].join(' ')
}

export async function startGuidedCreationChat(input: GuidedCreationInput) {
	const prompt = buildPrompt(input)
	const title = `Create ${input.kind}`
	const created = await createConversation({ title, model: input.model })
	void getConversations().refresh().catch(() => {})
	await goto(`/chat/${created.id}?prompt=${encodeURIComponent(prompt)}`)
}
