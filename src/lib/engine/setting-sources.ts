/**
 * Which filesystem setting sources a run is allowed to load.
 *
 * ## Why this is explicit now
 *
 * `buildEngineOptions` never set `settingSources`, and the SDK documents the omitted case
 * as "all sources are loaded (matches CLI defaults)". Verified against 0.3.278 with
 * `resolveSettings`: a `.claude/settings.json` sitting in the run's working directory was
 * merged into the effective settings, `permissions.allow` and `env` included.
 *
 * So the app was loading repo-committed configuration from every project with a working
 * directory — including cloned third-party repos — without anyone having decided to. That
 * is a decision worth making on purpose in either direction, which is what this module is.
 *
 * ## What each source means here
 *
 * - **`project`** (`.claude/settings.json`, and the `CLAUDE.md` / `.claude/commands/` /
 *   `.claude/skills/` that come with it) — repo-committed, so it is whatever the
 *   repository's authors put there. Loaded only for a project the operator has marked
 *   trusted. This is the useful half: it is what makes an imported repo behave for our
 *   agent the way it does for its own contributors (#23).
 *
 * - **`local`** (`.claude/settings.local.json`) — **never loaded, and not for the reason it
 *   looks like.** This file is gitignored, so it does not arrive with a clone; it arrives
 *   by being written into the sandbox. The agent can write into its own sandbox. Honouring
 *   it would let a run grant itself permissions between turns, which is a self-escalation
 *   path with no human in it. Trust cannot come from a file the untrusted party can write.
 *
 * - **`user`** (`~/.claude/settings.json`) — never loaded. In this container that is not an
 *   operator's config; it is the SDK's own auth directory, and the app's settings live in
 *   the database where `/settings` can show them.
 *
 * ## What this does not do
 *
 * Loading `project` still means a repo can ship hooks and `permissions.allow` rules. The
 * CLI filters an escalating `permissions.defaultMode` out of repo-committed tiers itself
 * (see the SDK's `filterEscalatingDefaultMode`), but allow-rules and hooks are honoured. So
 * "trusted" here has to mean what it says — the operator has looked, or wrote the repo
 * themselves. The gate is the point; the flag is just where the answer is kept.
 *
 * Pure and dependency-free so a spec can read it without `$env` or a database.
 */

/** Mirrors the SDK's `SettingSource`, kept local so this module imports nothing. */
export type EngineSettingSource = 'user' | 'project' | 'local'

/**
 * Isolation: no filesystem settings at all.
 *
 * The SDK spells this `[]`, which is meaningfully different from omitting the option —
 * omitting it loads everything.
 */
export const ISOLATED_SETTING_SOURCES: readonly EngineSettingSource[] = []

/** A trusted project's own committed configuration, and nothing else. */
export const TRUSTED_PROJECT_SETTING_SOURCES: readonly EngineSettingSource[] = ['project']

export type SettingSourceInput = {
	/**
	 * Whether this run is bound to a project whose committed settings the operator has
	 * marked trusted (`projects.settings_trusted`). Absent for a run with no project.
	 */
	settingsTrusted?: boolean | null
	/**
	 * Whether the run actually has a working directory. Without one there is no project
	 * directory to read, so the question is moot and isolation is the honest answer.
	 */
	hasWorkspace: boolean
}

/**
 * Resolve the sources for a run. Fails closed: anything short of "trusted project with a
 * working directory" gets isolation.
 */
export function resolveSettingSources(input: SettingSourceInput): EngineSettingSource[] {
	if (!input.hasWorkspace) return [...ISOLATED_SETTING_SOURCES]
	if (input.settingsTrusted !== true) return [...ISOLATED_SETTING_SOURCES]
	return [...TRUSTED_PROJECT_SETTING_SOURCES]
}
