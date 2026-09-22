import { expect, test } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk'
import { resolveSettingSources } from '../src/lib/engine/setting-sources'

/**
 * Which filesystem setting sources a run loads (#23).
 *
 * Runs without Postgres or a dev server: `setting-sources.ts` is pure, and the SDK's
 * `resolveSettings` reads the settings cascade without spawning the CLI or needing a model
 * credential.
 *
 * The first test is the important one. This whole change rests on a claim about the SDK —
 * that an omitted `settingSources` loads repo-committed settings — and a claim like that
 * deserves to be checked by the suite rather than remembered from a docstring, because the
 * day it stops being true is the day our reasoning about isolation quietly stops applying.
 */

test.describe('what the SDK does with the option omitted', () => {
	test('omitting settingSources loads repo-committed settings; [] does not', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'agentstudio-settingsources-'))
		try {
			await mkdir(join(dir, '.claude'), { recursive: true })
			await writeFile(
				join(dir, '.claude', 'settings.json'),
				JSON.stringify({
					env: { FROM_THE_REPO: 'yes' },
					permissions: { allow: ['Bash(echo hello)'] },
				}),
			)

			const omitted = await resolveSettings({ cwd: dir })
			const isolated = await resolveSettings({ cwd: dir, settingSources: [] })

			// This is the behaviour the engine used to get by not passing the option: a
			// `.claude/settings.json` sitting in the working directory — in an imported repo,
			// authored by whoever wrote that repo — merged into the run's effective settings.
			expect(omitted.effective.env?.FROM_THE_REPO).toBe('yes')
			expect(
				(omitted.effective as { permissions?: { allow?: string[] } }).permissions?.allow,
			).toContain('Bash(echo hello)')

			// And the isolation the app assumed it had all along, spelled explicitly.
			expect(isolated.effective.env?.FROM_THE_REPO).toBe(undefined)
			expect(
				(isolated.effective as { permissions?: { allow?: string[] } }).permissions?.allow,
			).toBe(undefined)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

test.describe('what we ask for', () => {
	test('an untrusted project is isolated', () => {
		expect(resolveSettingSources({ settingsTrusted: false, hasWorkspace: true })).toEqual([])
	})

	test('a trusted project loads its own committed settings, and only those', () => {
		const sources = resolveSettingSources({ settingsTrusted: true, hasWorkspace: true })

		expect(sources).toEqual(['project'])
		// `local` is `.claude/settings.local.json`, which the agent can write into its own
		// sandbox — honouring it would let a run grant itself permissions between turns.
		expect(sources).not.toContain('local')
		// `user` here is the SDK's auth directory, not an operator's config.
		expect(sources).not.toContain('user')
	})

	test('trust without a working directory is still isolated', () => {
		// There is no project directory to read, so the flag has nothing to apply to.
		expect(resolveSettingSources({ settingsTrusted: true, hasWorkspace: false })).toEqual([])
	})

	test('an absent or unknown trust value fails closed', () => {
		// A run with no project, and a row read before the column existed, must both land on
		// isolation rather than on "not false, therefore yes".
		expect(resolveSettingSources({ hasWorkspace: true })).toEqual([])
		expect(resolveSettingSources({ settingsTrusted: null, hasWorkspace: true })).toEqual([])
		expect(
			resolveSettingSources({ settingsTrusted: undefined, hasWorkspace: true }),
		).toEqual([])
	})
})
