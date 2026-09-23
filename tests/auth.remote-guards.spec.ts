import { expect, test } from '@playwright/test'
import ts from 'typescript'
import { listRemoteFunctions, type RemoteFunctionExport } from './remote-functions'

/**
 * Every remote function checks the session itself — the second lock.
 *
 * The hook refuses anonymous remote calls (auth.remote-gate.spec.ts), so from outside a
 * function's own check is unobservable. That is exactly why it rotted: 23 exports across
 * skills, agents, costs, runs, activity, models, notifications and tools had none, and the
 * only thing between them and the internet was a pathname check the client could spoof.
 * A guard that cannot be observed has to be pinned by reading the source.
 *
 * The rule: the handler's first statement calls `requireAuthenticatedRequestUser()`. First,
 * not merely somewhere — a check after an `await` or inside a branch is a check that some
 * path skips. Pure static analysis, so this runs without a server or a database.
 */

/**
 * Exports that run for a caller with no session, and why each is safe that way. These live
 * in the auth module because establishing a session is their job. The hook's own list
 * (remote-gate.server.ts) is narrower still: only login and setup are reachable anonymously.
 */
const EXEMPT: Record<string, string> = {
	'src/lib/auth/auth.remote.ts#loginCommand': 'creates the session; verifies the password itself',
	'src/lib/auth/auth.remote.ts#setupCommand': 'creates the owner; refuses once one exists',
	'src/lib/auth/auth.remote.ts#getSession': 'reports the session, including its absence',
	'src/lib/auth/auth.remote.ts#isProvisionedQuery': 'a single boolean about the instance',
	'src/lib/auth/auth.remote.ts#logout': 'clears the caller’s own cookie',
}

function key(fn: RemoteFunctionExport) {
	return `${fn.file}#${fn.name}`
}

/** Whether `statement` is `requireAuthenticatedRequestUser()` or `const x = requireAuthenticatedRequestUser()`. */
function isGuardCall(statement: ts.Statement | undefined): boolean {
	if (!statement) return false
	const isGuard = (expression: ts.Expression | undefined) =>
		!!expression &&
		ts.isCallExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === 'requireAuthenticatedRequestUser'
	if (ts.isExpressionStatement(statement)) return isGuard(statement.expression)
	if (ts.isVariableStatement(statement)) {
		return statement.declarationList.declarations.length === 1 && isGuard(statement.declarationList.declarations[0].initializer)
	}
	return false
}

test.describe('auth/remote-guards — each remote function checks the session first', () => {
	const remotes = listRemoteFunctions()

	test('every exported remote handler opens with requireAuthenticatedRequestUser()', () => {
		expect(remotes.length).toBeGreaterThan(100)
		const unguarded: string[] = []
		for (const fn of remotes) {
			if (fn.aliasOf) continue // guarded by the export it re-exports, checked on its own row
			if (EXEMPT[key(fn)]) continue
			const body = fn.handler?.body
			if (!body || !ts.isBlock(body) || !isGuardCall(body.statements[0])) unguarded.push(key(fn))
		}
		expect(unguarded, 'remote functions with no session check as their first statement').toEqual([])
	})

	test('the exemptions are real exports, so a rename cannot leave a stale hole in the list', () => {
		const present = new Set(remotes.map(key))
		for (const name of Object.keys(EXEMPT)) expect(present, name).toContain(name)
	})

	test('an alias points at a guarded export', () => {
		// `export const getStatus = getSandboxStatus` is served under both names.
		const aliases = remotes.filter((fn) => fn.aliasOf)
		for (const alias of aliases) {
			const target = remotes.find((fn) => fn.file === alias.file && fn.name === alias.aliasOf && !fn.aliasOf)
			expect(target, key(alias)).toBeTruthy()
			const body = target!.handler?.body
			expect(body && ts.isBlock(body) && isGuardCall(body.statements[0]), key(alias)).toBe(true)
		}
	})
})
