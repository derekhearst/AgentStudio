/**
 * Admission control for delegation (#32): what happens between the model deciding to hand
 * work to a child agent and that child starting.
 *
 * Delegation is the SDK's `Agent` tool (formerly `Task`; see `./builtin-tools`). Fan-out is
 * the model calling it several times in one message, which the CLI runs as a parallel batch
 * and answers in order. Nothing in the SDK bounds how many run at once, what they may cost,
 * or how deep the tree goes, so this module does, from inside the PreToolUse hook the engine
 * already installs for every call (`./stream.server`).
 *
 * ## Why the hook, and not `canUseTool`
 *
 * The CLI's `Agent` tool answers its own permission check with "allow" in every mode we hand
 * it (`default`, `acceptEdits`), so `canUseTool` is never consulted for a delegation. The
 * PreToolUse hook fires for every call, before the permission pipeline, and its answer is
 * binding — which makes it the one place a cap can actually hold.
 *
 * ## The rules
 *
 *   foreground       `run_in_background` is rewritten to false. A background child in our
 *                    one-shot query is held back and then killed after the CLI's print-mode
 *                    ceiling, reports only a token total, and would free its slot before it
 *                    finished. A foreground child blocks its own tool call, runs in parallel
 *                    with its siblings, and returns a full typed result.
 *   no isolation     `isolation` is stripped. `worktree` would branch the run's checkout
 *                    into a copy nothing merges back or cleans up, outside what the
 *                    containment guard and the approval cards know about; `remote` always
 *                    runs in the background.
 *   model            stripped when the parent runs on the gateway. The only values the tool
 *                    takes are Claude aliases, which the gateway cannot serve — the child
 *                    would fail, or be billed to a backend the run is not on. A Claude parent
 *                    keeps it.
 *   mode             stripped. The SDK documents it as ignored; a child inherits the parent's
 *                    permission mode, and nothing about delegation may widen it.
 *   the cap          at most `maxConcurrent` children live at once (`MAX_CONCURRENT_SUBAGENTS`).
 *                    The next call is refused, not queued: a hook that waited for a slot
 *                    would be timed out by the CLI, and a timed-out hook lets the call through.
 *                    The refusal tells the model to wait and re-issue, which it can.
 *   one level        a call made by a child (`agent_id` set on the hook input) is refused.
 *                    A child waiting on slots held by its own siblings can deadlock the tree.
 *   budget           each child passes the same budget gate a chat turn does, with the
 *                    child's own agent as its scope, before it starts. The parent's check
 *                    ran once, for the parent's agent; a fan-out must not walk through a
 *                    limit on the agents it delegates to.
 *
 * Everything fails closed. A budget check that throws or hangs, or any surprise in here, is
 * a refusal with a reason, never a call waved through.
 *
 * A slot is reserved synchronously, before the budget check awaits anything. The CLI runs a
 * parallel batch's hooks concurrently, and a check-then-reserve across an `await` would let
 * every call in the batch see the same free slot.
 *
 * ## Cancellation
 *
 * Foreground is also what makes the parent's Stop reach its children. Read in the bundled
 * CLI (2.1.278): a foreground child runs on the parent turn's own abort controller, while a
 * background one is given a fresh controller of its own. So `interrupt()` — what Stop sends
 * — aborts every foreground child with the turn, and the engine's `close()` afterwards ends
 * the CLI process outright. The typings add the other half: without `perTaskStopAffordance`
 * (which `./options.server` never declares) an interrupt kills background tasks too, so a
 * child that slipped past the rewrite would not outlive Stop either.
 *
 * Pure and dependency-free, like `./permission-mode`, so the spec can drive it directly.
 */

/** Children one turn may have running at once. See the module note. */
export const MAX_CONCURRENT_SUBAGENTS = 4

/**
 * How long a child's budget check may take before the child is refused. Well inside the
 * CLI's hook timeout: this check has to answer before the CLI stops waiting for the hook,
 * or the call would go through unchecked.
 */
export const CHILD_BUDGET_TIMEOUT_MS = 10_000

/** A budget verdict for one child. `reason` is what the model is told. */
export type ChildBudgetVerdict = { allowed: true } | { allowed: false; reason: string }

export type DelegationGateOptions = {
	/** Defaults to `MAX_CONCURRENT_SUBAGENTS`. */
	maxConcurrent?: number
	/** Whether the parent runs on the Claude CLI. A gateway parent's children keep no `model`. */
	parentIsClaude: boolean
	/**
	 * The budget gate for one child, given the agent key it asked for (`subagent_type`), or
	 * null when it named none. Omit to skip the check — only a spec does.
	 */
	checkChildBudget?: (agentKey: string | null) => Promise<ChildBudgetVerdict>
	/** Defaults to `CHILD_BUDGET_TIMEOUT_MS`. */
	budgetTimeoutMs?: number
}

export type DelegationRequest = {
	/** The delegation call's tool_use id. Its result is what frees the slot (`settle`). */
	toolUseId: string
	toolInput: unknown
	/** The hook input's `agent_id`: set when the call was made inside a subagent. */
	callerAgentId?: string | null
}

export type DelegationAdmission =
	| { admit: true; updatedInput: Record<string, unknown> }
	| { admit: false; reason: string }

export type DelegationGate = {
	/** Decide one delegation. An admitted call holds a slot until `settle` is called for it. */
	admit(request: DelegationRequest): Promise<DelegationAdmission>
	/**
	 * The rewritten input an admitted call runs with, or null. For the approval path: a call
	 * that is asked about reaches `canUseTool`, whose answer must carry the same rewrite.
	 */
	admittedInput(toolUseId: string): Record<string, unknown> | null
	/** The call's result arrived (or it will never run): free its slot. Idempotent. */
	settle(toolUseId: string): void
	/** Children holding a slot right now. */
	live(): number
	/** The turn ended: forget everything. */
	reset(): void
}

/** What a refused call is told when every slot is taken. Written for the model to act on. */
export function capReachedReason(maxConcurrent: number): string {
	return (
		`Refused: ${maxConcurrent} delegated agents are already running, which is as many as one turn may run at once. ` +
		'Wait for the running children to finish, then delegate the rest.'
	)
}

export const NESTED_DELEGATION_REASON =
	'Refused: a delegated agent cannot delegate further. Do the work yourself, or finish and report back to the agent that delegated to you.'

/**
 * The input a delegation actually runs with. See the module note for each field. Keeps every
 * other field the model sent, because the rewrite replaces the input outright.
 */
export function sanitizeDelegationInput(
	toolInput: unknown,
	options: { parentIsClaude: boolean },
): Record<string, unknown> {
	const input =
		toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
			? { ...(toolInput as Record<string, unknown>) }
			: {}
	delete input.isolation
	delete input.mode
	if (!options.parentIsClaude) delete input.model
	input.run_in_background = false
	return input
}

function agentKeyOf(toolInput: unknown): string | null {
	const key = (toolInput as { subagent_type?: unknown } | null)?.subagent_type
	return typeof key === 'string' && key.trim().length > 0 ? key.trim() : null
}

/** Race a budget check against its timeout. Settles to a refusal on timeout or throw. */
async function boundedBudgetCheck(
	check: NonNullable<DelegationGateOptions['checkChildBudget']>,
	agentKey: string | null,
	timeoutMs: number,
): Promise<ChildBudgetVerdict> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			check(agentKey),
			new Promise<ChildBudgetVerdict>((resolve) => {
				timer = setTimeout(
					() =>
						resolve({
							allowed: false,
							reason: 'Refused: the budget check for this delegation did not answer in time, so it was not started.',
						}),
					timeoutMs,
				)
			}),
		])
	} catch {
		return {
			allowed: false,
			reason: 'Refused: the budget check for this delegation failed, so it was not started.',
		}
	} finally {
		clearTimeout(timer)
	}
}

export function createDelegationGate(options: DelegationGateOptions): DelegationGate {
	const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? MAX_CONCURRENT_SUBAGENTS))
	const budgetTimeoutMs = options.budgetTimeoutMs ?? CHILD_BUDGET_TIMEOUT_MS
	/** Admitted children whose result has not arrived yet → the input each runs with. */
	const live = new Map<string, Record<string, unknown> | null>()

	return {
		async admit(request) {
			try {
				if (request.callerAgentId) return { admit: false, reason: NESTED_DELEGATION_REASON }

				// A hook fired twice for one call keeps the one slot it already holds.
				const alreadyAdmitted = live.has(request.toolUseId)
				if (!alreadyAdmitted && live.size >= maxConcurrent) {
					return { admit: false, reason: capReachedReason(maxConcurrent) }
				}
				// Reserve before awaiting anything — see the module note.
				if (!alreadyAdmitted) live.set(request.toolUseId, null)

				if (options.checkChildBudget) {
					const verdict = await boundedBudgetCheck(
						options.checkChildBudget,
						agentKeyOf(request.toolInput),
						budgetTimeoutMs,
					)
					if (!verdict.allowed) {
						live.delete(request.toolUseId)
						return { admit: false, reason: verdict.reason }
					}
				}

				const updatedInput = sanitizeDelegationInput(request.toolInput, { parentIsClaude: options.parentIsClaude })
				live.set(request.toolUseId, updatedInput)
				return { admit: true, updatedInput }
			} catch {
				live.delete(request.toolUseId)
				return {
					admit: false,
					reason: 'Refused: this delegation could not be checked, so it was not started.',
				}
			}
		},
		admittedInput(toolUseId) {
			return live.get(toolUseId) ?? null
		},
		settle(toolUseId) {
			live.delete(toolUseId)
		},
		live() {
			return live.size
		},
		reset() {
			live.clear()
		},
	}
}
