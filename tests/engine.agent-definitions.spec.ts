import { expect, test } from '@playwright/test'
import {
	SUBAGENT_DISALLOWED_TOOLS,
	agentDefinitionFrom,
	agentKey,
	buildAgentDefinitions,
	type AgentRowForDefinition,
} from '../src/lib/engine/agent-definitions'

/**
 * Mapping `agents` rows onto the SDK's `Options.agents` (#5).
 *
 * Pure-function tests: no DB, no SvelteKit, so this runs without Postgres or a dev server.
 *
 * Nothing wires these into a run yet — that is the rest of #5, and it needs the loop to
 * route messages by `parent_tool_use_id` first. These pin the decisions so that wiring
 * cannot quietly change them.
 */

function row(overrides: Partial<AgentRowForDefinition> = {}): AgentRowForDefinition {
	return {
		name: 'Reviewer',
		role: 'Reviews diffs for correctness',
		prompt: 'You review code.',
		model: 'claude-sonnet-5',
		status: 'idle',
		...overrides,
	}
}

test.describe('what is offered to the model', () => {
	test('an agent becomes a keyed definition the model can name', () => {
		const built = agentDefinitionFrom(row(), { parentIsClaude: true })

		expect(built?.key).toBe('reviewer')
		// `description` is what the model reads to choose an agent, so the role is in it.
		expect(built?.definition.description).toBe('Reviewer — Reviews diffs for correctness')
		expect(built?.definition.prompt).toBe('You review code.')
	})

	test('a paused agent is not offered', () => {
		// The only thing `agents.status` does anywhere in the app — see #66.
		expect(agentDefinitionFrom(row({ status: 'paused' }), { parentIsClaude: true })).toBeNull()
	})

	test('an agent with no prompt is not offered', () => {
		expect(agentDefinitionFrom(row({ prompt: '   ' }), { parentIsClaude: true })).toBeNull()
	})

	test('every subagent is refused ask_user', () => {
		// A child has no stream to ask down; without this it hangs on a question nobody sees.
		const built = agentDefinitionFrom(row(), { parentIsClaude: true })
		expect(built?.definition.disallowedTools).toEqual([...SUBAGENT_DISALLOWED_TOOLS])
		expect(SUBAGENT_DISALLOWED_TOOLS).toContain('mcp__agentstudio__ask_user')
	})

	test('a scoped agent carries its allow-list; an unscoped one carries none', () => {
		const scoped = agentDefinitionFrom(row({ allowedTools: ['Read', 'Grep'] }), {
			parentIsClaude: true,
		})
		expect(scoped?.definition.tools).toEqual(['Read', 'Grep'])

		// Omitted means "inherit all tools from parent", which is what an unscoped agent wants.
		expect(agentDefinitionFrom(row(), { parentIsClaude: true })?.definition.tools).toBe(undefined)
		expect(
			agentDefinitionFrom(row({ allowedTools: [] }), { parentIsClaude: true })?.definition.tools,
		).toBe(undefined)
	})
})

test.describe('which model a subagent gets', () => {
	test('a Claude model is named when the parent is on the Claude CLI', () => {
		expect(agentDefinitionFrom(row({ model: 'claude-opus-5' }), { parentIsClaude: true })?.definition.model).toBe(
			'claude-opus-5',
		)
	})

	test('a legacy vendor prefix is stripped, as the SDK wants a bare id', () => {
		expect(
			agentDefinitionFrom(row({ model: 'anthropic/claude-sonnet-5' }), { parentIsClaude: true })
				?.definition.model,
		).toBe('claude-sonnet-5')
	})

	test('a gateway run inherits instead of naming one', () => {
		// The gateway sets ANTHROPIC_MODEL process-wide, so a subagent naming a different
		// backend would be ignored or billed to the wrong place.
		expect(
			agentDefinitionFrom(row({ model: 'claude-opus-5' }), { parentIsClaude: false })?.definition.model,
		).toBe('inherit')
	})

	test('a non-Claude model inherits even on a Claude run', () => {
		expect(
			agentDefinitionFrom(row({ model: 'deepseek/deepseek-chat' }), { parentIsClaude: true })
				?.definition.model,
		).toBe('inherit')
		expect(agentDefinitionFrom(row({ model: null }), { parentIsClaude: true })?.definition.model).toBe(
			'inherit',
		)
	})
})

test.describe('keys', () => {
	test('a name becomes lowercase kebab', () => {
		expect(agentKey('Code Reviewer')).toBe('code-reviewer')
		expect(agentKey('  Plan!!  ')).toBe('plan')
		expect(agentKey('Résumé Writer')).toBe('r-sum-writer')
	})

	test('a name with nothing usable still yields a key', () => {
		expect(agentKey('!!!')).toBe('agent')
		expect(agentKey('')).toBe('agent')
	})

	test('a colliding key keeps the first agent, not the last', () => {
		// A `Task` call naming `reviewer` must reach the same agent every turn; "last write
		// wins" over a Record would make that depend on row order.
		const map = buildAgentDefinitions(
			[
				row({ name: 'Reviewer', prompt: 'first' }),
				row({ name: 'reviewer!', prompt: 'second' }),
			],
			{ parentIsClaude: true },
		)

		expect(Object.keys(map)).toEqual(['reviewer'])
		expect(map.reviewer.prompt).toBe('first')
	})

	test('paused and promptless rows are dropped from the map', () => {
		const map = buildAgentDefinitions(
			[
				row({ name: 'Active' }),
				row({ name: 'Paused', status: 'paused' }),
				row({ name: 'Empty', prompt: '' }),
			],
			{ parentIsClaude: true },
		)

		expect(Object.keys(map)).toEqual(['active'])
	})
})
