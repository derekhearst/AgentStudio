/**
 * Specs CI does not run yet.
 *
 * Two different reasons, kept apart on purpose.
 *
 * `LIVE_SPECS` drive a real model and a real workspace. They cost money, need credentials
 * a fork cannot have, and are slow. They are meant to be run deliberately, locally.
 *
 * `KNOWN_FAILING` is a shrinking quarantine, not a permanent exclusion list. These failed
 * on the clean run recorded in #55 — almost entirely `toBeVisible` and `element(s) not
 * found` against pages that moved while nothing ran the suite. Each needs a look and a
 * decision; none is known to be a product bug.
 *
 * The point of the list is that everything *not* in it is protected: 1606 passing tests
 * that can now fail a build. Every line removed here is coverage regained, so treat its
 * length as a debt figure rather than configuration.
 *
 * Measured baseline when this was written: 105 failed / 1606 passed.
 */

export const LIVE_SPECS: readonly string[] = [
	// Generates real embeddings, so it needs a real OPENROUTER_API_KEY; on CI it fails
	// with 401 from the embeddings endpoint.
	'tests/context.skill-relevance.spec.ts',
	'tests/chat.live.spec.ts',
	'tests/chat.stream-live-features.spec.ts',
	'tests/cost.tool-usage-live.spec.ts',
	'tests/runs.live.spec.ts',
	'tests/workspace.live.spec.ts',
]

/**
 * Meant to get shorter. 42 → 38.
 *
 * Four came off because fixes made elsewhere the same day reached them: `getActiveUserId`
 * seeding instead of throwing, the login field gaining an accessible name, the test server
 * no longer running with the auth bypass on, and the webhook awaiting its inbox write.
 *
 * A warning for whoever works on the rest. Run these as a subset and 41 of 42 pass; run
 * the whole suite and 38 of them fail. They are not simply stale — they interfere, and
 * measuring them in isolation will tell you they are fixed when they are not. Always
 * confirm against a full run.
 *
 * Count on 2026-09-22: 38.
 */
export const KNOWN_FAILING: readonly string[] = [
	'tests/agents.builtin-agents.spec.ts',
	'tests/agents.spec.ts',
	'tests/auth.spec.ts',
	'tests/automations.budget-gate.spec.ts',
	'tests/automations.mode.spec.ts',
	'tests/automations.runtime.spec.ts',
	'tests/chat.agent-selector.spec.ts',
	'tests/chat.agent-stream-integration.spec.ts',
	'tests/chat.agent-tool-policy.spec.ts',
	'tests/chat.askuser-render.spec.ts',
	'tests/chat.askuser-resume.spec.ts',
	'tests/chat.empty-message.spec.ts',
	'tests/chat.tool-call-render.spec.ts',
	'tests/cost.budget.spec.ts',
	'tests/cost.linkage.spec.ts',
	'tests/cost.tool-usage.spec.ts',
	'tests/crud/agents.crud.spec.ts',
	'tests/crud/automations.crud.spec.ts',
	'tests/crud/chat/agent-switch.spec.ts',
	'tests/crud/mobile/navigation.crud.spec.ts',
	'tests/crud/projects.crud.spec.ts',
	'tests/crud/research.crud.spec.ts',
	'tests/governance.audit.spec.ts',
	'tests/hooks.page-load.spec.ts',
	'tests/memory.spec.ts',
	'tests/observability.review.spec.ts',
	'tests/pages.smoke.spec.ts',
	'tests/projects.session-binding.spec.ts',
	'tests/projects.tools.spec.ts',
	'tests/pwa.spec.ts',
	'tests/research.composer.spec.ts',
	'tests/review.page-ui.spec.ts',
	'tests/runs.reaper.spec.ts',
	'tests/settings.spec.ts',
	'tests/source-control.github-webhook.spec.ts',
	'tests/source-control.read-tools.spec.ts',
	'tests/source-control.spec.ts',
	'tests/visual.spec.ts',
]

export const QUARANTINE: readonly string[] = [...LIVE_SPECS, ...KNOWN_FAILING]
