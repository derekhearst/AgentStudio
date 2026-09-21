import { checkBudgetLimits, type BudgetLimitRow } from '$lib/costs/budget.server'
import { logLlmUsage } from '$lib/costs/usage'
import { chat } from '$lib/llm/chat.server'
import { executeTool } from '$lib/tools/tools.server'
import type { ToolName } from '$lib/tools/tool-schemas'
import type { MonitorRow } from './monitors.schema'
import {
	buildModelQuestionPrompt,
	buildObservation,
	evaluateComparison,
	extractPath,
	monitorConditionSchema,
	parseYesNo,
	stableStringify,
	MONITOR_DEFAULT_MODEL,
	type MonitorObservableTool,
	type MonitorObservation,
} from './condition'

/**
 * #33 — observing a condition. One function, two paths.
 *
 *   tool_result   — run a read-only tool, pull a value out of the result, compare it against
 *                   the stored observation. Cheap and deterministic.
 *   model_question — fetch the same kind of context, then spend a few hundred tokens asking
 *                   a cheap model a yes/no question about it. This is the path that makes
 *                   monitors general and the path that can quietly cost money, so it goes
 *                   through `checkBudgetLimits` BEFORE the call, every single check, and the
 *                   tokens it spends land in `llm_usage` so the next check's gate sees them.
 *
 * Nothing here writes to the monitors table — the caller (`runMonitorCheck`) owns state
 * transitions so that "what happened" and "what we recorded" stay in one place.
 */

export type MonitorEvaluation =
	| { outcome: 'observed'; observation: MonitorObservation; met: boolean }
	/** A budget cap would have been exceeded. No model call was made and nothing was spent. */
	| { outcome: 'blocked'; blockedBy: BudgetLimitRow; message: string }
	/** The check could not be completed. Distinct from "the condition is false". */
	| { outcome: 'error'; message: string }

export async function evaluateMonitorCondition(monitor: MonitorRow, now = new Date()): Promise<MonitorEvaluation> {
	let condition
	try {
		condition = monitorConditionSchema.parse(monitor.condition)
	} catch (err) {
		return {
			outcome: 'error',
			message: `stored condition is not valid: ${err instanceof Error ? err.message : String(err)}`,
		}
	}

	try {
		if (condition.kind === 'tool_result') {
			const raw = await runObservationTool(monitor.userId, condition.tool, condition.args)
			const extracted = extractPath(raw, condition.extract)
			const candidate = buildObservation(extracted, false, undefined, now)
			const comparison = evaluateComparison({
				compare: condition.compare,
				current: candidate,
				previous: monitor.lastObservation ?? null,
				expected: condition.value,
			})
			return {
				outcome: 'observed',
				met: comparison.met,
				observation: { ...candidate, met: comparison.met, note: comparison.reason },
			}
		}

		// ── model path ──
		// Gate first. A blocked check costs nothing and is NOT counted against the monitor's
		// check budget by the caller, because no work was done.
		const budget = await checkBudgetLimits({ userId: monitor.userId, agentId: monitor.agentId ?? undefined })
		if (!budget.allowed && budget.blockedBy) {
			return {
				outcome: 'blocked',
				blockedBy: budget.blockedBy,
				message: `budget cap reached (${budget.blockedBy.scope} ${budget.blockedBy.period} limit $${budget.blockedBy.limitUsd})`,
			}
		}

		const contextParts: string[] = []
		for (const source of condition.context) {
			const raw = await runObservationTool(monitor.userId, source.tool, source.args)
			contextParts.push(`--- ${source.tool} ---\n${stableStringify(raw)}`)
		}
		const prompt = buildModelQuestionPrompt(condition.question, contextParts.join('\n\n'))
		const model = condition.model ?? MONITOR_DEFAULT_MODEL
		const response = await chat([{ role: 'user', content: prompt }], model)

		// Spend is recorded before the answer is interpreted — an unparseable answer still
		// cost tokens, and the budget gate must see them on the next check.
		void logLlmUsage({
			source: 'monitor',
			model,
			tokensIn: response.usage?.promptTokens ?? 0,
			tokensOut: response.usage?.completionTokens ?? 0,
			userId: monitor.userId,
			agentId: monitor.agentId ?? null,
			metadata: { monitorId: monitor.id, kind: 'model_question' },
		}).catch(() => undefined)

		const answer = (response.content ?? '').trim()
		const verdict = parseYesNo(answer)
		if (verdict === null) {
			// Reading an unparseable answer as "condition not met" would make the monitor
			// quietly useless for the rest of its life, so this is an error: it backs off and
			// eventually asks for a human.
			return { outcome: 'error', message: `model answer was not yes/no: ${answer.slice(0, 200) || '(empty)'}` }
		}
		return {
			outcome: 'observed',
			met: verdict,
			observation: buildObservation(answer, verdict, answer, now),
		}
	} catch (err) {
		return { outcome: 'error', message: err instanceof Error ? err.message : String(err) }
	}
}

/**
 * Run one read-only observation tool through the normal executor, so a monitor's view of the
 * world is exactly what an agent would see. No workspace options are passed: the monitor runs
 * detached, so tools resolve against the user's default sandbox.
 *
 * A tool that reports `success: false` throws — that is a failed check, not an observation of
 * "nothing". The distinction matters for `changed`: swallowing a fetch failure as an empty
 * value would register as a change and fire the action on an outage.
 */
async function runObservationTool(
	userId: string,
	tool: MonitorObservableTool,
	args: Record<string, unknown>,
): Promise<unknown> {
	const result = await executeTool({ name: tool as ToolName, arguments: args }, userId)
	if (!result.success) {
		throw new Error(`${tool} failed: ${result.error ?? 'unknown tool error'}`)
	}
	return result.result
}
