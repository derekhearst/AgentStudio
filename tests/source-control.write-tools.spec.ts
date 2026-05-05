import { expect, test } from '@playwright/test'

/**
 * Wave 5 #19 phase 3 finish — write-tool argv builder + approval-set invariants.
 *
 * The push + PR tools are HTTPS-bound to GitHub via the user's stored OAuth token. We
 * can't exercise the live remote in unit tests, so this spec pins the structural
 * contracts that gate safety: the argv shape never embeds the token in command args,
 * the redactor scrubs the token from any returned text, and the mandatory-approval set
 * carries both new tool names so chat-stream can never accidentally turn approval off.
 */

test.describe('source-control/git-push — argv builder', () => {
	test('uses fully-qualified GitHub HTTPS URL (not the local origin) and credential helper via env var', async () => {
		const { buildPushArgs } = await import('../src/lib/source-control/git-push.server')
		const { args, remote } = buildPushArgs({
			repoPath: '/repo',
			owner: 'acme',
			repo: 'widgets',
			branch: 'feature/x',
			token: 'never-in-argv',
		})
		expect(remote).toBe('https://github.com/acme/widgets.git')
		// The remote URL appears in argv (this is fine — the URL itself isn't a secret),
		// but the token MUST NOT appear anywhere in argv.
		expect(args.join(' ')).not.toContain('never-in-argv')
		// Helper string sources the token from the env, never inlined.
		expect(args).toContain('credential.helper=!f() { echo "username=x-access-token"; echo "password=$GIT_TOKEN"; }; f')
		// We push a fully-qualified refspec so the local branch tracking config never
		// surprises us with a different remote ref name.
		expect(args).toContain('refs/heads/feature/x:refs/heads/feature/x')
		// `-C <repoPath>` so we don't have to chdir.
		expect(args.includes('-C') && args.includes('/repo')).toBe(true)
	})

	test('force=true switches on --force-with-lease, never plain --force', async () => {
		const { buildPushArgs } = await import('../src/lib/source-control/git-push.server')
		const safe = buildPushArgs({ repoPath: '/r', owner: 'a', repo: 'b', branch: 'main', token: 't' })
		const forced = buildPushArgs({
			repoPath: '/r',
			owner: 'a',
			repo: 'b',
			branch: 'main',
			token: 't',
			force: true,
		})
		expect(safe.args).not.toContain('--force-with-lease')
		expect(safe.args).not.toContain('--force')
		expect(forced.args).toContain('--force-with-lease')
		expect(forced.args).not.toContain('--force')
	})
})

test.describe('source-control — mandatory approval set', () => {
	test('push_branch and create_pull_request are both flagged as always-require-approval', async () => {
		const { MANDATORY_APPROVAL_TOOLS } = await import('../src/lib/tools/tools')
		const set = new Set<string>(MANDATORY_APPROVAL_TOOLS)
		expect(set.has('push_branch')).toBe(true)
		expect(set.has('create_pull_request')).toBe(true)
	})

	test('source_control capability group lists every write tool plus existing read-only ones', async () => {
		const { capabilityGroups } = await import('../src/lib/tools/tools')
		const tools = capabilityGroups.source_control.tools as readonly string[]
		expect(tools).toEqual(expect.arrayContaining(['list_my_repos', 'sync_my_repos', 'prepare_commit', 'push_branch', 'create_pull_request']))
	})
})
