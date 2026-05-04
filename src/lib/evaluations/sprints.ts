/**
 * Wave 3 #14 evaluations plan phase 5 — sprint contract parser.
 *
 * Pure module (no $env / db / SvelteKit deps) so the loop can call it on every round and the
 * task UI can preview sprint structure without spinning up the runtime.
 *
 * A sprint contract is a `## Sprint N: <deliverable>` markdown header in the task spec, with
 * an optional `Round budget: <N>` line within the section. The runner uses these to:
 *   1. Track which sprint the run is currently in (based on rounds-elapsed).
 *   2. Trigger an evaluator pass at sprint boundaries (round count crosses a sprint's budget).
 *   3. Surface "Sprint 2 of 3 — Round 8/10" in the run viewer.
 *
 * Contract grammar (kept deliberately narrow so authors can't over-specify):
 *   ## Sprint 1: <human-readable deliverable name>
 *   Round budget: <integer>
 *   <free-form prose describing the sprint's deliverable>
 *
 *   ## Sprint 2: <next deliverable>
 *   ...
 *
 * If `Round budget:` is missing, the sprint is treated as unbounded (only the next sprint's
 * appearance triggers a boundary). If no sprints are declared, `parseSprintContracts` returns
 * an empty array and the runner skips per-sprint eval.
 */

export type SprintContract = {
	/** 1-indexed sprint number from the header. */
	index: number
	/** Deliverable name from the header. */
	deliverable: string
	/** Round budget for this sprint, or null when unbounded. */
	roundBudget: number | null
	/** Free-form description (the prose between this header and the next sprint header). */
	description: string
	/** Cumulative round threshold AFTER which this sprint's eval should fire. Null when budget is null. */
	cumulativeRoundEnd: number | null
}

const SPRINT_HEADER_RE = /^##\s+Sprint\s+(\d+)\s*[:\-]\s*(.+?)\s*$/im
const ROUND_BUDGET_RE = /^Round\s+budget\s*[:\-]\s*(\d+)\s*$/im

export function parseSprintContracts(spec: string): SprintContract[] {
	if (!spec || !spec.trim()) return []

	// Split spec into sections by sprint header. Use a stable global regex so we get the offsets.
	const lines = spec.split(/\r?\n/)
	const headerLineIndices: Array<{ line: number; match: RegExpMatchArray }> = []
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(SPRINT_HEADER_RE)
		if (m) headerLineIndices.push({ line: i, match: m })
	}
	if (headerLineIndices.length === 0) return []

	const sprints: SprintContract[] = []
	let cumulative = 0

	for (let s = 0; s < headerLineIndices.length; s++) {
		const { line: startLine, match } = headerLineIndices[s]
		const endLine = s + 1 < headerLineIndices.length ? headerLineIndices[s + 1].line : lines.length
		const sectionLines = lines.slice(startLine + 1, endLine)
		const sectionText = sectionLines.join('\n').trim()

		const budgetMatch = sectionText.match(ROUND_BUDGET_RE)
		const roundBudget = budgetMatch ? Number.parseInt(budgetMatch[1], 10) : null

		// Strip the round-budget line from the description.
		const description = sectionText.replace(ROUND_BUDGET_RE, '').trim()

		const cumulativeRoundEnd = roundBudget !== null ? cumulative + roundBudget : null
		if (roundBudget !== null) cumulative += roundBudget

		sprints.push({
			index: Number.parseInt(match[1], 10),
			deliverable: match[2].trim(),
			roundBudget,
			description,
			cumulativeRoundEnd,
		})
	}

	return sprints
}

/**
 * Given the current loop round and the sprint contracts, return whether the previous round
 * just crossed a sprint boundary (i.e. `prevRound = sprint.cumulativeRoundEnd`). Used by the
 * runner to decide when to trigger an interim evaluator pass mid-run.
 *
 * Edge case: returns `null` when `prevRound` is 0 (no rounds completed yet) or when the spec
 * has no bounded sprints. Returns the sprint that just ended so the caller can include its
 * deliverable in the evaluator's context.
 */
export function sprintBoundaryAt(
	contracts: SprintContract[],
	prevRound: number,
): SprintContract | null {
	if (prevRound <= 0) return null
	for (const sprint of contracts) {
		if (sprint.cumulativeRoundEnd !== null && sprint.cumulativeRoundEnd === prevRound) {
			return sprint
		}
	}
	return null
}

/**
 * Compute the active sprint for a given round count. Returns the LAST sprint whose
 * `cumulativeRoundEnd` is greater than or equal to the round (i.e. the sprint we're "inside").
 * Falls back to the final sprint when the round exceeds all budgets — useful for "sprint 3 of 3"
 * UI labels even when the run runs over.
 */
export function activeSprintForRound(
	contracts: SprintContract[],
	round: number,
): SprintContract | null {
	if (contracts.length === 0) return null
	for (const sprint of contracts) {
		if (sprint.cumulativeRoundEnd !== null && round <= sprint.cumulativeRoundEnd) {
			return sprint
		}
	}
	return contracts[contracts.length - 1]
}
