import { z } from 'zod'
import type { EvaluationFinding, EvaluationVerdict } from './evaluations.schema'
import type { ResponseFormat } from '$lib/llm/chat.server'

/**
 * Wave 3 #14 evaluations plan phase 2 — pure response parser.
 *
 * Lives in its own module (no $env / db.server / SvelteKit imports) so unit tests can exercise
 * the structured-output extraction + JSON-fence stripping + parse-error fallback without
 * spinning up the runtime. The `runEvaluatorPass` server function imports from here.
 */

const findingSchema = z.object({
	severity: z.enum(['info', 'warning', 'error']),
	category: z.string().optional(),
	message: z.string().min(1),
	path: z.string().optional(),
	suggestion: z.string().optional(),
})

const evaluatorResponseSchema = z.object({
	verdict: z.enum(['pass', 'fail', 'needs_revision']),
	confidence: z.number().min(0).max(1).optional(),
	findings: z.array(findingSchema).default([]),
})

/**
 * OpenRouter `response_format: json_schema` body for the evaluator. Supplied by callers of
 * `chat()` so models that support strict mode return validated JSON; the parser below still
 * handles the fallback case where the model ignored the field or wrapped output in a fence.
 */
export const evaluatorResponseFormat: ResponseFormat = {
	type: 'json_schema',
	json_schema: {
		name: 'evaluator_response',
		strict: true,
		schema: z.toJSONSchema(evaluatorResponseSchema) as Record<string, unknown>,
	},
}

export type ParsedEvaluatorResponse = {
	verdict: EvaluationVerdict
	confidence: number | null
	findings: EvaluationFinding[]
	fallback?: 'parse_error' | 'empty_response'
}

export function parseEvaluatorResponse(raw: string): ParsedEvaluatorResponse {
	if (!raw.trim()) {
		return {
			verdict: 'needs_revision',
			confidence: 0,
			findings: [{ severity: 'error', message: 'evaluator returned empty response' }],
			fallback: 'empty_response',
		}
	}

	const candidate = extractJson(raw)
	const result = evaluatorResponseSchema.safeParse(candidate)
	if (result.success) {
		return {
			verdict: result.data.verdict,
			confidence: result.data.confidence ?? null,
			findings: result.data.findings,
		}
	}

	return {
		verdict: 'needs_revision',
		confidence: 0.2,
		findings: [
			{
				severity: 'error',
				message: `evaluator response failed schema validation: ${result.error.issues[0]?.message ?? 'unknown'}`,
			},
		],
		fallback: 'parse_error',
	}
}

/**
 * Extract a JSON object from raw text. The seeded evaluator prompt instructs no code fence /
 * preamble, but real models occasionally wrap the response — strip the ```json fence and any
 * leading/trailing prose before parsing.
 */
function extractJson(raw: string): unknown {
	const trimmed = raw.trim()
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
	const candidate = fenced ? fenced[1].trim() : trimmed
	try {
		return JSON.parse(candidate)
	} catch {
		const start = candidate.indexOf('{')
		const end = candidate.lastIndexOf('}')
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(candidate.slice(start, end + 1))
			} catch {
				return null
			}
		}
		return null
	}
}
