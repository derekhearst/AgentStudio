import { goto } from '$app/navigation'
import { createConversation } from '$lib/chat'

export type CreationKind = 'project' | 'agent' | 'task' | 'skill'

type GuidedCreationInput = {
	kind: CreationKind
	model?: string
	context?: Record<string, string | undefined>
}

function buildPrompt({ kind, context = {} }: GuidedCreationInput) {
	const commonRules = [
		'Help me create this using a cooperative planning flow.',
		'First ask clarifying questions one at a time if needed.',
		'Do not execute any tool calls until I approve the final plan card.',
		'When ready, present a concise execution plan for approval.',
	]

	if (kind === 'project') {
		return [
			'Create a new project for me.',
			...commonRules,
			'Gather project name, goal scope, and optional description before planning execution.',
		].join(' ')
	}

	if (kind === 'agent') {
		return [
			'Create a new agent for me.',
			...commonRules,
			'Gather name, role, model, and system prompt preferences before producing the execution plan.',
		].join(' ')
	}

	if (kind === 'task') {
		const agentName = context.agentName ? `Target agent: ${context.agentName}.` : ''
		const agentId = context.agentId ? `Agent id: ${context.agentId}.` : ''
		return [
			'Create a new task for an agent.',
			agentName,
			agentId,
			...commonRules,
			'Gather title, detailed description, and priority assumptions before planning tool execution.',
		]
			.filter(Boolean)
			.join(' ')
	}

	return [
		'Create a new reusable skill for me.',
		...commonRules,
		'Gather skill name, description, tags, and main markdown content goals before proposing execution.',
	].join(' ')
}

export async function startGuidedCreationChat(input: GuidedCreationInput) {
	const prompt = buildPrompt(input)
	const title = `Create ${input.kind}`
	const created = await createConversation({ title, model: input.model })
	await goto(`/chat/${created.id}?prompt=${encodeURIComponent(prompt)}`)
}
