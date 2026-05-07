/**
 * Pure parsers for tool-block payloads emitted on the chat stream.
 *
 * The chat page persists each tool call as a JSON blob (`arguments` going in,
 * `result` coming out). These helpers shape that raw payload into the
 * structured forms the UI cards expect, with permissive fallbacks so a
 * partially-formed block still renders something useful.
 */

export type AskUserOption = {
	label: string
	description?: string
	recommended?: boolean
}

export type AskUserQuestion = {
	header: string
	question: string
	options: AskUserOption[]
	allowFreeformInput?: boolean
}

export type PlanStep = {
	title: string
	detail?: string
	estimatedDurationMin?: number
	estimatedCostUsd?: number
	blastRadius?: 'local' | 'shared' | 'production'
	reversible?: boolean
}

export type PlanProposal = {
	summary: string
	steps: PlanStep[]
	risks?: string[]
	rollback?: string
	totalEstimatedCostUsd?: number
	totalEstimatedDurationMin?: number
}

type ToolBlockLike = {
	arguments: string
	result?: string | null
}

export function parseJsonFallback(raw: string | undefined | null): Record<string, unknown> {
	try {
		return JSON.parse(raw || '{}') as Record<string, unknown>
	} catch {
		return {}
	}
}

export function getAskUserQuestionsFromTool(block: ToolBlockLike): AskUserQuestion[] {
	const args = parseJsonFallback(block.arguments)
	const result = block.result ? parseJsonFallback(block.result) : {}
	const fromArgs = Array.isArray(args.questions) ? args.questions : []
	const fromResult = Array.isArray(result.questions) ? result.questions : []
	const source = fromArgs.length > 0 ? fromArgs : fromResult

	return source
		.map((entry) => {
			const row = (entry ?? {}) as Record<string, unknown>
			const header = typeof row.header === 'string' ? row.header : ''
			const question = typeof row.question === 'string' ? row.question : header
			const options = Array.isArray(row.options)
				? (row.options as Array<Record<string, unknown>>)
						.map((opt) => ({
							label: typeof opt.label === 'string' ? opt.label : '',
							description: typeof opt.description === 'string' ? opt.description : undefined,
							recommended: typeof opt.recommended === 'boolean' ? opt.recommended : undefined,
						}))
						.filter((opt) => opt.label.length > 0)
				: []
			const allowFreeformInput =
				typeof row.allowFreeformInput === 'boolean' ? row.allowFreeformInput : true
			return { header, question, options, allowFreeformInput }
		})
		.filter((row) => row.question.trim().length > 0)
}

export function getPlanProposalFromTool(block: ToolBlockLike): PlanProposal | null {
	const args = parseJsonFallback(block.arguments)
	if (!args || typeof args !== 'object') return null
	if (typeof args.summary !== 'string' || !Array.isArray(args.steps)) return null
	const steps: PlanStep[] = (args.steps as Array<Record<string, unknown>>)
		.map((s) => {
			if (!s || typeof s !== 'object' || typeof s.title !== 'string') return null
			const step: PlanStep = { title: s.title }
			if (typeof s.detail === 'string') step.detail = s.detail
			if (typeof s.estimatedDurationMin === 'number') step.estimatedDurationMin = s.estimatedDurationMin
			if (typeof s.estimatedCostUsd === 'number') step.estimatedCostUsd = s.estimatedCostUsd
			if (s.blastRadius === 'local' || s.blastRadius === 'shared' || s.blastRadius === 'production') {
				step.blastRadius = s.blastRadius
			}
			if (typeof s.reversible === 'boolean') step.reversible = s.reversible
			return step
		})
		.filter((s): s is PlanStep => s !== null)
	if (steps.length === 0) return null
	const plan: PlanProposal = { summary: args.summary, steps }
	if (Array.isArray(args.risks)) plan.risks = args.risks.filter((r): r is string => typeof r === 'string')
	if (typeof args.rollback === 'string') plan.rollback = args.rollback
	if (typeof args.totalEstimatedCostUsd === 'number') plan.totalEstimatedCostUsd = args.totalEstimatedCostUsd
	if (typeof args.totalEstimatedDurationMin === 'number')
		plan.totalEstimatedDurationMin = args.totalEstimatedDurationMin
	return plan
}

export type ResearchPlanProposal = {
	summary: string
	subQuestions: string[]
	rationale?: string
}

export type ResearchPlanResult = {
	researchId: string
	jobId?: string
	subQuestionCount?: number
}

/**
 * Parse a `propose_research_plan` tool block. The schema validates `summary` + `subQuestions`,
 * with an optional `rationale`. Returns null if the args are malformed (which is recoverable —
 * the chat UI just won't show the sidebar plan card and the user can ask the agent to retry).
 */
export function getResearchPlanFromTool(block: ToolBlockLike): ResearchPlanProposal | null {
	const args = parseJsonFallback(block.arguments)
	if (!args || typeof args !== 'object') return null
	if (typeof args.summary !== 'string' || !Array.isArray(args.subQuestions)) return null
	const subQuestions = (args.subQuestions as unknown[])
		.filter((q): q is string => typeof q === 'string')
		.map((q) => q.trim())
		.filter((q) => q.length > 0)
	if (subQuestions.length < 1) return null
	const proposal: ResearchPlanProposal = { summary: args.summary, subQuestions }
	if (typeof args.rationale === 'string' && args.rationale.trim().length > 0) {
		proposal.rationale = args.rationale.trim()
	}
	return proposal
}

/**
 * Parse the result payload from a completed `propose_research_plan` tool call. The result
 * carries the researchId so the sidebar can switch to the "running" state and start polling.
 */
export function getResearchPlanResultFromTool(block: ToolBlockLike): ResearchPlanResult | null {
	if (!block.result) return null
	const result = parseJsonFallback(block.result)
	if (!result || typeof result !== 'object') return null
	const researchId = typeof result.researchId === 'string' ? result.researchId : null
	if (!researchId) return null
	const out: ResearchPlanResult = { researchId }
	if (typeof result.jobId === 'string') out.jobId = result.jobId
	if (typeof result.subQuestionCount === 'number') out.subQuestionCount = result.subQuestionCount
	return out
}

export function getAskUserAnswersFromTool(block: ToolBlockLike): Record<string, string> | null {
	if (!block.result) return null
	const result = parseJsonFallback(block.result)
	if (!result || typeof result !== 'object') return null
	const answers = result.answers
	if (!answers || typeof answers !== 'object') return null
	const out: Record<string, string> = {}
	for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
		if (typeof v === 'string') out[k] = v
	}
	return Object.keys(out).length > 0 ? out : null
}
