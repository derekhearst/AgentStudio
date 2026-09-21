/**
 * Scratch runner for the Claude Agent SDK spike. Delete once the decision is made.
 *
 * Proves two things without needing the database, auth, or a dev server:
 *   1. the SDK authenticates off the Claude Code CLI login (no API key)
 *   2. AgentStudio's own tool is callable in-process by the agent
 *
 * Run: bun scripts/spike-agent-sdk.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { spikeOptions, SPIKE_IMAGE_TOOL } from '../src/lib/spike/claude-agent.server'

const prompt =
	process.argv.slice(2).join(' ') ||
	'Generate an image of a red bicycle in the rain. Use the generate_image tool, then tell me in one sentence what happened.'

console.log('ANTHROPIC_API_KEY set:', Boolean(process.env.ANTHROPIC_API_KEY))
console.log('allowed tools:', spikeOptions.allowedTools)
console.log('prompt:', prompt, '\n')

let toolCalls = 0
let sawText = false

for await (const message of query({ prompt, options: spikeOptions })) {
	const msg = message as { type?: string; subtype?: string; message?: { content?: Array<Record<string, unknown>> } }

	if (msg.type === 'system') {
		console.log(`[system] ${msg.subtype ?? ''}`)
		continue
	}

	for (const block of msg.message?.content ?? []) {
		if (block.type === 'text' && String(block.text ?? '').trim()) {
			sawText = true
			console.log(`[text] ${String(block.text).slice(0, 400)}`)
		}
		if (block.type === 'tool_use') {
			toolCalls++
			console.log(`[tool_use] ${String(block.name)} ${JSON.stringify(block.input)}`)
		}
		if (block.type === 'tool_result') {
			// content is string | block[] depending on the tool, so normalise.
			const raw = block.content
			const text = Array.isArray(raw)
				? raw.map((c: { text?: string }) => c.text ?? '').join(' ')
				: typeof raw === 'string'
					? raw
					: JSON.stringify(raw)
			console.log(`[tool_result] ${text.slice(0, 300)}`)
		}
	}
}

console.log('\n--- spike result ---')
console.log('streamed assistant text :', sawText ? 'YES' : 'NO')
console.log('tool calls              :', toolCalls, toolCalls > 0 ? `(expected ${SPIKE_IMAGE_TOOL})` : '')
console.log('verdict                 :', sawText && toolCalls > 0 ? 'PASS' : 'INCOMPLETE')
