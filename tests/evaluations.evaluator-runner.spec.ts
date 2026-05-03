import { expect, test } from '@playwright/test'

/**
 * Wave 3 #14 evaluations plan phase 2 — evaluator-runner pure response parser.
 *
 * `parseEvaluatorResponse` is the structured-output gate: it takes raw LLM text and returns a
 * typed verdict + findings + confidence, OR falls back to a `needs_revision` verdict with a
 * single error finding when the response is empty / unparseable / fails schema validation.
 *
 * The runner itself (which calls `chat()` and writes to `run_evaluations`) requires $env so it
 * can't be import-tested directly here; the integration path is exercised end-to-end any time
 * a chat run with `eval_required=true` completes (the run viewer's Evaluations panel will
 * surface the verdict). This file pins the parser invariants so a regression in the structured
 * output handling is caught immediately.
 */

test.describe('evaluations/evaluator-runner — pure response parser', () => {
	test('clean JSON response parses to the typed verdict', async () => {
		const { parseEvaluatorResponse } = await import('../src/lib/evaluations/evaluator-parse')
		const raw = JSON.stringify({
			verdict: 'pass',
			confidence: 0.92,
			findings: [{ severity: 'info', category: 'style', message: 'consider a comment' }],
		})
		const result = parseEvaluatorResponse(raw)
		expect(result.verdict).toBe('pass')
		expect(result.confidence).toBeCloseTo(0.92, 2)
		expect(result.findings).toHaveLength(1)
		expect(result.findings[0].category).toBe('style')
		expect(result.fallback).toBeUndefined()
	})

	test('json-fenced response strips the fence before parsing', async () => {
		const { parseEvaluatorResponse } = await import('../src/lib/evaluations/evaluator-parse')
		const raw = '```json\n{"verdict":"needs_revision","confidence":0.4,"findings":[{"severity":"warning","message":"missing tests"}]}\n```'
		const result = parseEvaluatorResponse(raw)
		expect(result.verdict).toBe('needs_revision')
		expect(result.findings[0].severity).toBe('warning')
		expect(result.fallback).toBeUndefined()
	})

	test('unfenced response with leading prose still extracts the JSON object', async () => {
		const { parseEvaluatorResponse } = await import('../src/lib/evaluations/evaluator-parse')
		const raw = 'Sure! Here is my analysis:\n{"verdict":"fail","findings":[{"severity":"error","message":"unsafe operation"}]}'
		const result = parseEvaluatorResponse(raw)
		expect(result.verdict).toBe('fail')
		expect(result.findings).toHaveLength(1)
		expect(result.fallback).toBeUndefined()
	})

	test('empty response falls back to needs_revision with an empty_response marker', async () => {
		const { parseEvaluatorResponse } = await import('../src/lib/evaluations/evaluator-parse')
		const result = parseEvaluatorResponse('')
		expect(result.verdict).toBe('needs_revision')
		expect(result.fallback).toBe('empty_response')
		expect(result.findings).toHaveLength(1)
		expect(result.findings[0].severity).toBe('error')
	})

	test('schema-failing response (missing verdict) falls back with parse_error', async () => {
		const { parseEvaluatorResponse } = await import('../src/lib/evaluations/evaluator-parse')
		const raw = JSON.stringify({ confidence: 0.5, findings: [] }) // verdict missing
		const result = parseEvaluatorResponse(raw)
		expect(result.verdict).toBe('needs_revision')
		expect(result.fallback).toBe('parse_error')
	})

	test('invalid verdict value falls back with parse_error', async () => {
		const { parseEvaluatorResponse } = await import('../src/lib/evaluations/evaluator-parse')
		const raw = JSON.stringify({ verdict: 'maybe', confidence: 0.6, findings: [] })
		const result = parseEvaluatorResponse(raw)
		expect(result.verdict).toBe('needs_revision')
		expect(result.fallback).toBe('parse_error')
	})

	test('truly garbage response with no extractable JSON falls back with parse_error', async () => {
		const { parseEvaluatorResponse } = await import('../src/lib/evaluations/evaluator-parse')
		const raw = 'I think the agent did fine but I cannot give a structured response.'
		const result = parseEvaluatorResponse(raw)
		expect(result.verdict).toBe('needs_revision')
		expect(result.fallback).toBe('parse_error')
	})
})
