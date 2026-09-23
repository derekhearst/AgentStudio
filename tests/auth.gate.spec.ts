import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { sql as dsql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { authenticateContext, readEnvVar } from './helpers'
import { FIRST_RUN_PATH_PREFIXES, isPublicPath, rendersWithoutShell, resolveAuthGate } from '../src/lib/auth/gate'
import { PLACEHOLDER_AUTH_PASSWORD, provisionOwner, provisionOwnerFromEnv } from '../src/lib/auth/provision.server'
import { verifyPassword } from '../src/lib/auth/password.server'
import {
	announceSetupToken,
	retireSetupToken,
	setupTokenMatches,
	setupTokenRequired,
} from '../src/lib/auth/setup-token.server'

/**
 * First run: the setup gate, owner provisioning and the setup token (#1, #2).
 *
 * The suite's database always has an owner, and it must keep it — the `users` row is a
 * singleton that every other spec's data hangs off, and deleting it cascades through all of
 * it. So "a fresh install" is simulated two ways instead:
 *
 *   - the gate is a pure function of (path, owner exists, signed in), tested as a matrix;
 *   - provisioning runs against an empty stand-in: a TEMP `users` table created LIKE the
 *     real one (same unique indexes, the singleton included) inside a transaction that is
 *     always rolled back. Postgres searches the temp schema first, so the unqualified
 *     `users` the code queries is the stand-in, and the real row is never read or locked.
 *
 * The live-server checks at the bottom cover the "owner exists" side end to end.
 */

test.describe('auth/gate — the rules', () => {
	const gate = (pathname: string, ownerExists: boolean, authenticated = false) =>
		resolveAuthGate({ pathname, ownerExists, authenticated })

	test('before an owner exists, only setup, the health check and static assets are reachable', () => {
		for (const path of ['/setup', '/api/health', '/_app/immutable/entry/start.js', '/favicon.ico', '/favicon.svg']) {
			expect(gate(path, false), path).toBeNull()
		}
		// `/login` too: there is nobody to sign in as. And a session cookie changes nothing.
		for (const path of ['/', '/chat', '/login', '/research', '/demo', '/api/webhooks/github', '/api/cron', '/settings']) {
			expect(gate(path, false), path).toBe('/setup')
			expect(gate(path, false, true), `${path} (with a session)`).toBe('/setup')
		}
	})

	test('once an owner exists, /setup is closed and the page gate applies', () => {
		expect(gate('/setup', true, false)).toBe('/login')
		expect(gate('/setup', true, true)).toBe('/')
		expect(gate('/chat', true, false)).toBe('/login')
		expect(gate('/', true, false)).toBe('/login')
		expect(gate('/chat', true, true)).toBeNull()
		expect(gate('/login', true, true)).toBe('/')
		expect(gate('/login', true, false)).toBeNull()
		for (const path of ['/api/webhooks/github', '/api/health', '/api/cron', '/demo/error-notice', '/_app/x.js', '/favicon.ico']) {
			expect(gate(path, true, false), path).toBeNull()
		}
	})

	test('a prefix matches whole path segments only', () => {
		expect(isPublicPath('/login')).toBe(true)
		expect(isPublicPath('/loginx')).toBe(false)
		expect(isPublicPath('/api/healthz')).toBe(false)
		expect(gate('/setupx', false)).toBe('/setup')
	})

	test('#1: every page reachable before an owner exists renders without the console shell', () => {
		// The shell's nav runs an authenticated query. On a fresh install /setup rendered it,
		// that query threw 401, and an empty database had no way in. Any page the first-run
		// gate lets through must render bare.
		for (const prefix of FIRST_RUN_PATH_PREFIXES) {
			if (prefix.startsWith('/api/')) continue // an endpoint, not a page
			expect(rendersWithoutShell(prefix), prefix).toBe(true)
		}
		expect(rendersWithoutShell('/login')).toBe(true)
		expect(rendersWithoutShell('/chat')).toBe(false)

		const layout = readFileSync(join(process.cwd(), 'src/routes/+layout.svelte'), 'utf8')
		expect(layout, 'the root layout decides chromeless pages from the shared list').toMatch(
			/isChromeless = \$derived\(rendersWithoutShell\(page\.url\.pathname\)\)/,
		)
	})

	test('the hook asks the gate, and the dev bypass attaches only to an owner with a password', () => {
		const hook = readFileSync(join(process.cwd(), 'src/hooks.server.ts'), 'utf8')
		expect(hook).toMatch(/await authGateRedirect\(event\)/)
		expect(hook).toMatch(/await findOwnerIdentity\(\)/)
		const authServer = readFileSync(join(process.cwd(), 'src/lib/auth/auth.server.ts'), 'utf8')
		const identity = authServer.slice(authServer.indexOf('export async function findOwnerIdentity'))
		expect(identity.slice(0, identity.indexOf('\n}\n'))).toMatch(/isNotNull\(users\.passwordHash\)/)
	})
})

test.describe('auth/setup-token', () => {
	test('a production build asks for it; a dev server does not', () => {
		expect(setupTokenRequired({ devBuild: false })).toBe(true)
		expect(setupTokenRequired({ devBuild: true })).toBe(false)
	})

	test('only the announced token opens setup, and only until setup completes', () => {
		// The operator finds the token in the server log, so it must be printed — once per token.
		const printed: string[] = []
		const originalWarn = console.warn
		console.warn = (...args: unknown[]) => void printed.push(args.map(String).join(' '))
		try {
			retireSetupToken()
			expect(setupTokenMatches('anything'), 'no token issued yet').toBe(false)

			const token = announceSetupToken()
			expect(token.length).toBeGreaterThanOrEqual(20)
			expect(announceSetupToken(), 'announcing again returns the same token').toBe(token)
			expect(printed).toHaveLength(1)
			expect(printed[0]).toContain(token)
			expect(setupTokenMatches(token)).toBe(true)
			expect(setupTokenMatches(`  ${token}\n`), 'pasted with whitespace').toBe(true)
			expect(setupTokenMatches(`${token}x`)).toBe(false)
			expect(setupTokenMatches('')).toBe(false)
			expect(setupTokenMatches(undefined)).toBe(false)

			retireSetupToken()
			expect(setupTokenMatches(token), 'retired after setup').toBe(false)
			const next = announceSetupToken()
			expect(next).not.toBe(token)
			expect(printed).toHaveLength(2)
			retireSetupToken()
		} finally {
			console.warn = originalWarn
		}
	})
})

test.describe('auth/provision — against an empty users table', () => {
	let client: postgres.Sql

	test.beforeAll(() => {
		const url = readEnvVar('DATABASE_URL')
		if (!url) throw new Error('DATABASE_URL is required')
		client = postgres(url, { max: 1 })
	})

	test.afterAll(async () => {
		await client?.end({ timeout: 5 })
	})

	class RolledBack extends Error {}
	type TestTx = Parameters<Parameters<PostgresJsDatabase['transaction']>[0]>[0]

	/** Run `fn` against a stand-in `users` table that starts empty. Always rolled back. */
	async function withFreshUsers(fn: (db: TestTx) => Promise<void>) {
		try {
			await drizzle(client).transaction(async (tx) => {
				await tx.execute(dsql`create temp table users (like public.users including all) on commit drop`)
				await fn(tx)
				throw new RolledBack()
			})
		} catch (err) {
			if (!(err instanceof RolledBack)) throw err
		}
	}

	async function ownerRows(db: TestTx) {
		return (await db.execute(dsql`select id, name, username, password_hash from users`)) as unknown as Array<{
			id: string
			name: string
			username: string
			password_hash: string | null
		}>
	}

	test('the stand-in is really empty and really the temp table', async () => {
		await withFreshUsers(async (db) => {
			expect(await ownerRows(db)).toHaveLength(0)
			const [where] = (await db.execute(
				dsql`select n.nspname like 'pg_temp%' as temp from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = 'users'::regclass`,
			)) as unknown as Array<{ temp: boolean }>
			expect(where.temp).toBe(true)
		})
	})

	test('a fresh install gets its owner; a second attempt changes nothing', async () => {
		await withFreshUsers(async (db) => {
			const first = await provisionOwner(db, { name: 'Ada', password: 'first-password' })
			expect(first).toMatchObject({ created: true, passwordSet: true })

			const [owner] = await ownerRows(db)
			expect(owner).toMatchObject({ id: first.userId, name: 'Ada', username: 'owner' })
			expect(await verifyPassword('first-password', owner.password_hash!)).toBe(true)

			// Setup submitted again (or the boot step on the next restart): refused, untouched.
			const second = await provisionOwner(db, { name: 'Mallory', username: 'mallory', password: 'second-password' })
			expect(second).toEqual({ userId: first.userId, created: false, passwordSet: false })
			const after = await ownerRows(db)
			expect(after).toHaveLength(1)
			expect(after[0]).toEqual(owner) // byte-identical hash, same name and username
		})
	})

	test('a row without a password is claimed in place, keeping its id', async () => {
		await withFreshUsers(async (db) => {
			// A half-finished setup, or an owner whose password was cleared to reopen setup.
			const [row] = (await db.execute(
				dsql`insert into users (name, username) values ('Old name', 'legacy_user') returning id`,
			)) as unknown as Array<{ id: string }>

			const result = await provisionOwner(db, { name: 'New name', password: 'claimed-password' })
			expect(result).toEqual({ userId: row.id, created: true, passwordSet: true })
			const [owner] = await ownerRows(db)
			expect(owner).toMatchObject({ id: row.id, name: 'New name', username: 'owner' })
			expect(await verifyPassword('claimed-password', owner.password_hash!)).toBe(true)
		})
	})

	test('overwrite resets only the password', async () => {
		await withFreshUsers(async (db) => {
			const created = await provisionOwner(db, { name: 'Ada', username: 'ada', password: 'first-password' })
			const reset = await provisionOwner(db, { name: 'Ignored', username: 'ignored', password: 'second-password' }, { overwrite: true })
			expect(reset).toEqual({ userId: created.userId, created: false, passwordSet: true })
			const [owner] = await ownerRows(db)
			expect(owner).toMatchObject({ id: created.userId, name: 'Ada', username: 'ada' })
			expect(await verifyPassword('second-password', owner.password_hash!)).toBe(true)
			expect(await verifyPassword('first-password', owner.password_hash!)).toBe(false)
		})
	})

	test('bad input is refused before anything is written', async () => {
		await withFreshUsers(async (db) => {
			await expect(provisionOwner(db, { name: 'Ada', password: 'short' })).rejects.toThrow(/at least 8/)
			await expect(provisionOwner(db, { name: 'Ada', username: 'no spaces', password: 'long-enough' })).rejects.toThrow(/Username/)
			expect(await ownerRows(db)).toHaveLength(0)
		})
	})

	test('boot: AUTH_PASSWORD creates the owner once, and leaves the environment', async () => {
		await withFreshUsers(async (db) => {
			const env: Record<string, string | undefined> = {
				AUTH_PASSWORD: 'from-the-environment',
				AUTH_OWNER_NAME: 'Deploy Owner',
			}
			expect(await provisionOwnerFromEnv(db, env)).toMatchObject({ status: 'created', username: 'owner' })
			expect(env.AUTH_PASSWORD, 'agent subprocesses inherit process.env; the password must not').toBeUndefined()
			const [owner] = await ownerRows(db)
			expect(owner.name).toBe('Deploy Owner')
			expect(await verifyPassword('from-the-environment', owner.password_hash!)).toBe(true)

			// Next boot, with a different AUTH_PASSWORD: an existing password is never overwritten.
			const nextBoot: Record<string, string | undefined> = { AUTH_PASSWORD: 'changed-in-compose' }
			expect(await provisionOwnerFromEnv(db, nextBoot)).toEqual({ status: 'kept', userId: owner.id })
			expect(nextBoot.AUTH_PASSWORD).toBeUndefined()
			expect((await ownerRows(db))[0]).toEqual(owner)
		})
	})

	test('boot: no AUTH_PASSWORD, or the .env.example placeholder, creates nothing', async () => {
		await withFreshUsers(async (db) => {
			expect(await provisionOwnerFromEnv(db, {})).toEqual({ status: 'not-configured' })
			expect(await provisionOwnerFromEnv(db, { AUTH_PASSWORD: '   ' })).toEqual({ status: 'not-configured' })

			const env: Record<string, string | undefined> = { AUTH_PASSWORD: PLACEHOLDER_AUTH_PASSWORD }
			expect(await provisionOwnerFromEnv(db, env)).toEqual({ status: 'placeholder' })
			expect(env.AUTH_PASSWORD).toBeUndefined()
			expect(await ownerRows(db)).toHaveLength(0)
		})
	})
})

test.describe('auth/gate — the running server, which has an owner', () => {
	test('/setup sends an anonymous visitor to /login and a signed-in one home', async ({ request, page }) => {
		const anonymous = await request.get('/setup', { maxRedirects: 0 })
		expect(anonymous.status()).toBe(303)
		expect(anonymous.headers().location).toBe('/login')

		await authenticateContext(page.context())
		const signedIn = await page.request.get('/setup', { maxRedirects: 0 })
		expect(signedIn.status()).toBe(303)
		expect(signedIn.headers().location).toBe('/')
	})

	test('/api/health reports the owner without counting it towards health', async ({ request }) => {
		const response = await request.get('/api/health', { maxRedirects: 0 })
		expect(response.headers()['content-type']).toContain('application/json')
		const body = (await response.json()) as { ownerProvisioned?: unknown; status?: unknown }
		expect(body.ownerProvisioned).toBe(true)
		expect(['ok', 'degraded']).toContain(body.status)
	})
})
