import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'

type DbLike = typeof db

/**
 * Wave 3 #14 evaluations plan phase 1 — first-party default evaluator agent.
 *
 * Seeded once at boot with a fixed UUID so re-runs of the seed are idempotent. The system
 * prompt instructs structured-output (JSON) shape that matches `EvaluationFinding` — the
 * runner parses the response with Zod and falls back to a `needs_revision` verdict on parse
 * failure. Cheap model by default (`openai/gpt-4o-mini`) per the plan's cost-optimization
 * guideline; operators can swap the model on the agent detail page like any other agent.
 *
 * The seed uses `ON CONFLICT (id) DO NOTHING` so user edits to the prompt / model survive a
 * boot. Bumping the UUID is the escape hatch for shipping a substantively-new prompt.
 */

export const DEFAULT_EVALUATOR_AGENT_ID = '00000000-0000-4000-8000-000000000ea1'

const DEFAULT_EVALUATOR_PROMPT = `You are an Evaluator. Your job is to score the most recent agent run for correctness, completeness, and quality. You DO NOT execute work — you only judge whether the work meets the user's request.

## Output format
Respond with ONLY a JSON object matching this exact schema (no preamble, no code fence, no commentary):

{
  "verdict": "pass" | "fail" | "needs_revision",
  "confidence": <number between 0 and 1>,
  "findings": [
    {
      "severity": "info" | "warning" | "error",
      "category": "<short tag like 'correctness', 'style', 'safety', 'completeness'>",
      "message": "<one-sentence finding>",
      "path": "<optional file path>",
      "suggestion": "<optional one-sentence suggested fix>"
    }
  ]
}

## Verdict rules
- "pass": output fully addresses the request and is correct. No errors, no critical gaps.
- "needs_revision": minor issues — the agent should retry with the findings as guidance.
- "fail": fundamental problem — wrong approach, unsafe, or unrecoverable.

## Severity rules
- "error": something is wrong or missing that blocks acceptance.
- "warning": output is acceptable but has a clear improvement opportunity.
- "info": observation worth noting but not actionable.

Be terse. One finding per distinct issue. Avoid duplicating issues across findings. If everything is fine, return verdict=pass with an empty findings array and confidence near 1.0.`

export async function seedDefaultEvaluator(database: DbLike): Promise<{ inserted: number }> {
	const result = await database
		.insert(agents)
		.values({
			id: DEFAULT_EVALUATOR_AGENT_ID,
			name: 'Default Evaluator',
			role: 'Read-only critic that scores agent runs against the user\'s original request.',
			systemPrompt: DEFAULT_EVALUATOR_PROMPT,
			model: 'openai/gpt-4o-mini',
			kind: 'evaluator',
			status: 'active',
			config: {
				// Read-only tool surface — evaluators don't make changes.
				allowedTools: ['read', 'list', 'search'],
			},
		})
		.onConflictDoNothing({ target: agents.id })
		.returning({ id: agents.id })

	return { inserted: result.length }
}
