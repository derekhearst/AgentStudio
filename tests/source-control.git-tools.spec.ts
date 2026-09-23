import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { git, makeTempDir } from './git-http-server'

/**
 * The agent's read-only git tools (`git_status`, `git_log`, `git_diff`) in a real worktree.
 *
 * `git_diff` is classified read-only, so it runs without approval — including in plan mode.
 * Its `ref` comes straight from the model, and used to go into git's argv as-is: a ref of
 * `--output=<path>` made git write the diff to any path the server process could reach,
 * outside the workspace and outside the Bash sandbox.
 */

async function inWorktree<T>(fn: (ctx: { workspace: string; tmp: string }) => Promise<T>): Promise<T> {
	const tmp = makeTempDir('git-tools')
	const previous = process.env.SANDBOX_WORKSPACE
	process.env.SANDBOX_WORKSPACE = join(tmp.path, 'sandbox')
	try {
		const source = join(tmp.path, 'source')
		git(['init', '-b', 'main', source])
		writeFileSync(join(source, 'a.txt'), 'one\n')
		git(['add', '-A'], source)
		git(['commit', '-m', 'first'], source)
		appendFileSync(join(source, 'a.txt'), 'two\n')
		git(['commit', '-am', 'second'], source)

		const { toolUserContext, getWorkspace, ensureWorkspaceDir } = await import('../src/lib/tools/sandbox.server')
		return await toolUserContext.run({ userId: 'e2e-git-tools', runId: 'e2e-run', worktree: { repoPath: source } }, async () => {
			await ensureWorkspaceDir()
			return fn({ workspace: getWorkspace(), tmp: tmp.path })
		})
	} finally {
		if (previous === undefined) delete process.env.SANDBOX_WORKSPACE
		else process.env.SANDBOX_WORKSPACE = previous
		tmp.cleanup()
	}
}

test.describe('tools/git_diff — the model-supplied ref', () => {
	test('a ref shaped like an option is refused, and git writes nothing', async () => {
		const { sourceControlHandlers } = await import('../src/lib/tools/handlers/source-control.server')
		await inWorktree(async ({ tmp }) => {
			const target = join(tmp, 'written-by-git.txt')
			for (const ref of [`--output=${target}`, '-R', '--no-index']) {
				const result = await sourceControlHandlers.git_diff(
					{ name: 'git_diff', arguments: { ref } },
					{ userId: 'e2e-git-tools', runId: 'e2e-run', startedAt: Date.now() },
				)
				expect(result.success).toBe(false)
				expect(result.error).toMatch(/Invalid ref/)
			}
			expect(existsSync(target)).toBe(false)
		})
	})

	test('ordinary refs still diff', async () => {
		const { sourceControlHandlers } = await import('../src/lib/tools/handlers/source-control.server')
		await inWorktree(async ({ workspace }) => {
			appendFileSync(join(workspace, 'a.txt'), 'three\n')
			const result = await sourceControlHandlers.git_diff(
				{ name: 'git_diff', arguments: { ref: 'HEAD~1' } },
				{ userId: 'e2e-git-tools', runId: 'e2e-run', startedAt: Date.now() },
			)
			expect(result.success).toBe(true)
			const stdout = (result.result as { stdout: string }).stdout
			expect(stdout).toContain('+two')
			expect(stdout).toContain('+three')

			const status = await sourceControlHandlers.git_status(
				{ name: 'git_status', arguments: {} },
				{ userId: 'e2e-git-tools', runId: 'e2e-run', startedAt: Date.now() },
			)
			expect(status.success).toBe(true)
			expect((status.result as { stdout: string }).stdout).toContain('a.txt')
		})
	})
})
