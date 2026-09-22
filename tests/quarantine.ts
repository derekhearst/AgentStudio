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
	// Reclassified from KNOWN_FAILING: it triggers a cron tick and then asserts the
	// automation produced a chat_run, an assistant message and an llm_usage row. That
	// only happens if a model actually answers, so it belongs with the other specs that
	// need credentials rather than on a list of things to repair.
	'tests/automations.runtime.spec.ts',
	// Both of its tests run a maintenance automation end to end and assert on what the
	// model wrote. It was taken *off* the quarantine on the strength of a green local
	// run — and a developer machine has a working credential where CI has a placeholder,
	// so CI failed it with `UnauthorizedResponseError` from the OpenRouter SDK. Passing
	// locally is not evidence a spec can run in CI.
	'tests/automations.output-routing.spec.ts',
]

/**
 * Meant to get shorter. 42 → 38 → 31 → 28 → 23 → 17 → 11.
 *
 * A warning for whoever works on the rest. Run these as a subset and nearly all pass; run
 * the whole suite and most of them fail. They are not simply stale — they interfere, and
 * measuring them in isolation will tell you they are fixed when they are not. Always
 * confirm against a full run, and against *both* projects: several of the seven removed
 * on 2026-09-21 passed on desktop and failed on mobile.
 *
 * Those seven were stale rather than interfering, and four product bugs fell out of
 * fixing them: no <h1> on any desktop page, header actions dropped entirely on mobile,
 * settings re-reading cached remote queries after every mutation, and a missing VAPID
 * config failing a notification that had already been written.
 *
 * Count on 2026-09-21: 11.
 */
export const KNOWN_FAILING: readonly string[] = [
	'tests/chat.agent-selector.spec.ts',
	'tests/chat.agent-stream-integration.spec.ts',
	'tests/chat.agent-tool-policy.spec.ts',
	'tests/chat.askuser-resume.spec.ts',
	'tests/crud/agents.crud.spec.ts',
	'tests/crud/automations.crud.spec.ts',
	'tests/crud/chat/agent-switch.spec.ts',
	'tests/crud/mobile/navigation.crud.spec.ts',
	'tests/crud/projects.crud.spec.ts',
	'tests/crud/research.crud.spec.ts',
	// Screenshot baselines are platform-specific (`-win32.png`), so this can never pass on
	// a Linux runner. It needs Linux baselines generated in CI before it can come off.
	'tests/visual.spec.ts',
]

export const QUARANTINE: readonly string[] = [...LIVE_SPECS, ...KNOWN_FAILING]
