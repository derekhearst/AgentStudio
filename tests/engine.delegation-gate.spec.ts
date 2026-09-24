import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import {
	MAX_CONCURRENT_SUBAGENTS,
	NESTED_DELEGATION_REASON,
	capReachedReason,
	createDelegationGate,
	sanitizeDelegationInput,
} from '../src/lib/engine/delegation-gate'
import { DISALLOWED_BUILTIN_TOOLS, isDelegationTool } from '../src/lib/engine/builtin-tools'
import { SUBAGENT_DISALLOWED_TOOLS, buildAgentRoster } from '../src/lib/engine/agent-definitions'
import { DELEGATION_POLICY_LINES } from '../src/lib/agents/subagent-result'

/**
 * #32 — admission control for delegation: the cap, the one-level rule, the per-child budget
 * check and the foreground rewrite (`src/lib/engine/delegation-gate.ts`).
 *
 * Pure: no database, no SDK. The gate is driven the way the PreToolUse hook drives it; the
 * hook's own wiring is pinned in `engine.delegation-stream.spec.ts`.
 */

const call = (id: string, input: Record<string, unknown> = { subagent_type: 'reviewer', prompt: 'p' }) => ({
	toolUseId: id,
	toolInput: input,
})

test.describe('the concurrency cap', () => {
	test('admits up to the cap and refuses the next, with a reason the model can act on', async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		for (let i = 0; i < MAX_CONCURRENT_SUBAGENTS; i++) {
			expect((await gate.admit(call(`a${i}`))).admit).toBe(true)
		}
		const refused = await gate.admit(call('over'))
		expect(refused).toEqual({ admit: false, reason: capReachedReason(MAX_CONCURRENT_SUBAGENTS) })
		expect(capReachedReason(4)).toMatch(/Wait for the running children to finish, then delegate the rest/)
		expect(gate.live()).toBe(MAX_CONCURRENT_SUBAGENTS)
	})

	test('a settled child frees its slot for the next delegation', async () => {
		const gate = createDelegationGate({ parentIsClaude: true, maxConcurrent: 2 })
		await gate.admit(call('a'))
		await gate.admit(call('b'))
		expect((await gate.admit(call('c'))).admit).toBe(false)
		gate.settle('a')
		expect((await gate.admit(call('c'))).admit).toBe(true)
		// Idempotent: settling twice, or settling a refused call, frees nothing extra.
		gate.settle('a')
		gate.settle('never-admitted')
		expect(gate.live()).toBe(2)
	})

	test('a parallel batch cannot all see the same free slot while its budget checks await', async () => {
		// The CLI runs a batch's hooks concurrently. Reserving after the await would admit all six.
		const gate = createDelegationGate({
			parentIsClaude: true,
			checkChildBudget: async () => {
				await new Promise((r) => setTimeout(r, 10))
				return { allowed: true }
			},
		})
		const verdicts = await Promise.all(Array.from({ length: 6 }, (_, i) => gate.admit(call(`p${i}`))))
		expect(verdicts.filter((v) => v.admit)).toHaveLength(MAX_CONCURRENT_SUBAGENTS)
		expect(verdicts.filter((v) => !v.admit)).toHaveLength(6 - MAX_CONCURRENT_SUBAGENTS)
	})

	test('the same call admitted twice keeps one slot', async () => {
		const gate = createDelegationGate({ parentIsClaude: true, maxConcurrent: 1 })
		expect((await gate.admit(call('a'))).admit).toBe(true)
		expect((await gate.admit(call('a'))).admit).toBe(true)
		expect(gate.live()).toBe(1)
	})

	test('reset forgets every slot', async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		await gate.admit(call('a'))
		gate.reset()
		expect(gate.live()).toBe(0)
		expect(gate.admittedInput('a')).toBeNull()
	})
})

test.describe('one level deep', () => {
	test('a call made inside a child is refused and holds no slot', async () => {
		const gate = createDelegationGate({ parentIsClaude: true })
		const verdict = await gate.admit({ ...call('nested'), callerAgentId: 'agent-abc' })
		expect(verdict).toEqual({ admit: false, reason: NESTED_DELEGATION_REASON })
		expect(gate.live()).toBe(0)
	})

	test('no subagent definition offers a way to delegate, or to fan out by script', () => {
		for (const name of ['Agent', 'Task', 'Workflow', 'SendMessage']) expect(SUBAGENT_DISALLOWED_TOOLS).toContain(name)
		// Workflow is off for the parent too: its agents would never meet this gate. So is
		// SendMessage, which can wake a finished child outside any `Agent` call.
		expect(DISALLOWED_BUILTIN_TOOLS).toContain('Workflow')
		expect(DISALLOWED_BUILTIN_TOOLS).toContain('SendMessage')
	})

	test('both spellings of the tool are the delegation tool', () => {
		expect(isDelegationTool('Agent')).toBe(true)
		expect(isDelegationTool('Task')).toBe(true)
		expect(isDelegationTool('TaskStop')).toBe(false)
		expect(isDelegationTool('agent')).toBe(false)
	})
})

test.describe('the per-child budget check', () => {
	test('is asked with the key the child named, and a block refuses it with the reason', async () => {
		const asked: Array<string | null> = []
		const gate = createDelegationGate({
			parentIsClaude: true,
			checkChildBudget: async (key) => {
				asked.push(key)
				return key === 'pricey' ? { allowed: false, reason: 'Refused: over budget' } : { allowed: true }
			},
		})
		expect((await gate.admit(call('ok', { subagent_type: 'cheap', prompt: 'p' }))).admit).toBe(true)
		expect(await gate.admit(call('no', { subagent_type: 'pricey', prompt: 'p' }))).toEqual({
			admit: false,
			reason: 'Refused: over budget',
		})
		expect(await gate.admit(call('none', { prompt: 'p' }))).toMatchObject({ admit: true })
		expect(asked).toEqual(['cheap', 'pricey', null])
		// The refused child gave its reserved slot back.
		expect(gate.live()).toBe(2)
	})

	test('a check that throws refuses — it never waves the child through', async () => {
		const gate = createDelegationGate({
			parentIsClaude: true,
			checkChildBudget: async () => {
				throw new Error('db down')
			},
		})
		const verdict = await gate.admit(call('a'))
		expect(verdict.admit).toBe(false)
		expect(!verdict.admit && verdict.reason).toMatch(/budget check .* failed/)
		expect(gate.live()).toBe(0)
	})

	test('a check that hangs refuses once its time is up', async () => {
		const gate = createDelegationGate({
			parentIsClaude: true,
			budgetTimeoutMs: 20,
			checkChildBudget: () => new Promise(() => {}),
		})
		const verdict = await gate.admit(call('a'))
		expect(verdict.admit).toBe(false)
		expect(!verdict.admit && verdict.reason).toMatch(/did not answer in time/)
		expect(gate.live()).toBe(0)
	})
})

test.describe('the input a child runs with', () => {
	const asked = {
		subagent_type: 'reviewer',
		description: 'Review a.ts',
		prompt: 'Review it',
		run_in_background: true,
		isolation: 'worktree',
		mode: 'bypassPermissions',
		model: 'opus',
		name: 'rev-1',
	}

	test('always the foreground, never isolated, never a mode of its own — the rest kept', () => {
		const out = sanitizeDelegationInput(asked, { parentIsClaude: true })
		expect(out).toEqual({
			subagent_type: 'reviewer',
			description: 'Review a.ts',
			prompt: 'Review it',
			run_in_background: false,
			model: 'opus',
			name: 'rev-1',
		})
		// A missing flag is written too: the SDK's default is the background.
		expect(sanitizeDelegationInput({ prompt: 'p' }, { parentIsClaude: true }).run_in_background).toBe(false)
		// The model's own object is not mutated; the rewrite replaces the input outright.
		expect(asked.run_in_background).toBe(true)
	})

	test('a gateway parent drops the model, which only ever names a Claude alias', () => {
		expect(sanitizeDelegationInput(asked, { parentIsClaude: false })).not.toHaveProperty('model')
	})

	test('an admitted call remembers its rewrite for the approval path', async () => {
		const gate = createDelegationGate({ parentIsClaude: false })
		const verdict = await gate.admit(call('a', asked))
		expect(verdict.admit && verdict.updatedInput.run_in_background).toBe(false)
		expect(gate.admittedInput('a')).toEqual(verdict.admit ? verdict.updatedInput : null)
		gate.settle('a')
		expect(gate.admittedInput('a')).toBeNull()
	})

	test('garbage input still becomes a foreground call rather than a throw', () => {
		expect(sanitizeDelegationInput(null, { parentIsClaude: true })).toEqual({ run_in_background: false })
		expect(sanitizeDelegationInput(['x'], { parentIsClaude: true })).toEqual({ run_in_background: false })
	})
})

test.describe('the roster the gate and the ledger read', () => {
	test('names the agents row behind each offered key, first row winning a collision', () => {
		const row = (id: string, name: string) => ({ id, name, role: 'r', prompt: 'p', model: null, status: 'idle' })
		const { definitions, agentIdByKey } = buildAgentRoster(
			[row('id-1', 'Reviewer'), row('id-2', 'reviewer!'), row('id-3', 'Writer')],
			{ parentIsClaude: true },
		)
		expect(Object.keys(definitions)).toEqual(['reviewer', 'writer'])
		expect(agentIdByKey).toEqual({ reviewer: 'id-1', writer: 'id-3' })
	})
})

test.describe('what the rest of the app is told', () => {
	test('the orchestrator prompt states the same cap the gate enforces', () => {
		const policy = DELEGATION_POLICY_LINES.join('\n')
		expect(policy).toContain(`At most ${MAX_CONCURRENT_SUBAGENTS} delegated agents run at once`)
		expect(policy).toMatch(/ONE message/)
	})

	/*
	 * Read as source: `options.server.ts` and the route import `$env`, which the Playwright
	 * runtime cannot resolve (see `engine.tool-decision.spec.ts`).
	 */
	test('Stop takes the children down: the per-task stop affordance is never declared', () => {
		// Declared, an interrupt would spare running background agents (sdk.d.ts).
		const options = readFileSync(resolve('src/lib/engine/options.server.ts'), 'utf8')
		expect(options).not.toMatch(/perTaskStopAffordance\s*:/)
		const engine = readFileSync(resolve('src/lib/engine/stream.server.ts'), 'utf8')
		expect(engine).not.toMatch(/perTaskStopAffordance\s*:/)
	})

	test('the chat stream hands every turn a delegation gate and writes the children to the ledger', () => {
		const route = readFileSync(resolve('src/routes/chat/[id]/stream/+server.ts'), 'utf8')
		expect(route).toMatch(/const delegation = createChatDelegation\(/)
		expect(route).toMatch(/delegation:\s*delegation\.gate,/)
		// Each child is booked as its card closes, so the next child's budget check sees it.
		expect(route).toMatch(/onSubagentDone:\s*delegation\.ledger\.record,/)
		expect(route).toMatch(/await delegation\.ledger\.settle\(/)
		// The parent's row is what is left once the children are carved out.
		expect(route).toMatch(/tokensIn:\s*parentUsage\.inputTokens/)
	})
})
