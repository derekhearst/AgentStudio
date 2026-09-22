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
	'tests/chat.live.spec.ts',
	'tests/chat.stream-live-features.spec.ts',
	'tests/cost.tool-usage-live.spec.ts',
	'tests/runs.live.spec.ts',
	'tests/workspace.live.spec.ts',
]

/** Meant to get shorter. Count on 2026-09-21: 34. */
export const KNOWN_FAILING: readonly string[] = [
	'tests/agents.builtin-agents.spec.ts',
	'tests/agents.spec.ts',
	'tests/auth.spec.ts',
	'tests/automations.budget-gate.spec.ts',
	'tests/automations.mode-dispatch.spec.ts',
	'tests/automations.mode.spec.ts',
	'tests/automations.output-routing.spec.ts',
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

/**
 * The same #55 backlog, in subdirectories. These were missed when the list was first
 * derived: the failure log writes nested paths with backslashes and the extraction
 * only matched forward slashes, so they were silently absent.
 */
export const KNOWN_FAILING_NESTED: readonly string[] = [
	'tests/crud/agents.crud.spec.ts',
	'tests/crud/automations.crud.spec.ts',
	'tests/crud/chat/home-redirect.spec.ts',
	'tests/crud/chat/agent-switch.spec.ts',
	'tests/crud/mobile/navigation.crud.spec.ts',
	'tests/crud/projects.crud.spec.ts',
	'tests/crud/research.crud.spec.ts',
	'tests/crud/settings.crud.spec.ts',
]

export const QUARANTINE: readonly string[] = [...LIVE_SPECS, ...KNOWN_FAILING, ...KNOWN_FAILING_NESTED]
