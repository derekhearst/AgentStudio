import { redirect, type Handle, type HandleServerError } from '@sveltejs/kit'
import { dev } from '$app/environment'
import { and, arrayContains, sql } from 'drizzle-orm'
import { getSessionUser, isProvisioned } from '$lib/auth/auth.server'
import { refuseAnonymousRemoteCall } from '$lib/auth/remote-gate.server'
import { authDevBypassEnabled } from '$lib/auth/dev-bypass'
import { db, ensureDatabaseReady } from '$lib/db.server'
import { users } from '$lib/auth/auth.schema'
import { skills } from '$lib/skills/skills.schema'
import { logger } from '$lib/observability/logger'

// Dev-mode auth bypass. Active only in a dev build (`vite dev`), with NODE_ENV !== 'production'
// AND AUTH_DEV_BYPASS=1 — a production build ignores the variable (see dev-bypass.ts).
// When active, requests without a session cookie are auto-attached to the singleton user
// row, skipping the /login redirect. Useful when you've lost the dev password or are
// driving the app from a viewer that can't set cookies via DevTools.
const AUTH_DEV_BYPASS = authDevBypassEnabled({ devBuild: dev, env: process.env })
if (AUTH_DEV_BYPASS) {
	logger.warn('[hooks] AUTH_DEV_BYPASS=1 — anonymous requests will auto-attach to the singleton user. Set AUTH_DEV_BYPASS=0 in .env to disable.')
}
let warnedAboutBypass = false
async function loadSingletonUserForBypass() {
	const [row] = await db.select({ id: users.id, name: users.name, username: users.username }).from(users).limit(1)
	return row ?? null
}

// Cleanup old capability-group skill seed records once on startup.
let cleanedUpLegacyCapabilitySkills = false
async function cleanupLegacyCapabilitySkills() {
	if (cleanedUpLegacyCapabilitySkills) return
	cleanedUpLegacyCapabilitySkills = true
	try {
		await db
			.delete(skills)
			.where(and(arrayContains(skills.tags, ['capability-group']), sql`${skills.name} LIKE 'capability:%'`))
	} catch (e) {
		cleanedUpLegacyCapabilitySkills = false
		logger.error('[hooks] Failed to cleanup legacy capability group skills', { err: e })
	}
}

// `/api/webhooks` is unauthenticated by design — third-party providers (GitHub, …) POST
// here without session cookies. The handlers verify provider signatures themselves so the
// path-level skip is safe; never broaden this prefix without an explicit signature check.
// `/api/cron` is public for the same reason: an external scheduler has no session, so the
// handler checks a session OR the CRON_SECRET bearer itself, and refuses when neither holds.
const PUBLIC_PATH_PREFIXES = ['/login', '/setup', '/demo', '/api/webhooks', '/api/health', '/api/cron']

function isPublicPath(pathname: string) {
	// `/_app` here is the static bundle. Remote functions (`/_app/remote/…`) never get this
	// far: `handle` settles them first, because their pathname is not the real one.
	if (pathname.startsWith('/_app') || pathname.startsWith('/favicon')) {
		return true
	}

	return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export const handle: Handle = async ({ event, resolve }) => {
	await ensureDatabaseReady()
	await cleanupLegacyCapabilitySkills()

	let user = await getSessionUser(event.cookies)
	if (!user && AUTH_DEV_BYPASS) {
		const fallback = await loadSingletonUserForBypass()
		if (fallback) {
			user = fallback
			if (!warnedAboutBypass) {
				warnedAboutBypass = true
				logger.warn('[hooks] AUTH_DEV_BYPASS active — requests without a session attach to the singleton user. Disable in .env before exposing this server.')
			}
		}
	}
	event.locals.user = user
	event.locals.authenticated = user !== null

	// Remote-function calls are gated on their real request path and settled here. Every
	// check below reads `event.url.pathname`, which for a remote call is a client-supplied
	// header — see src/lib/auth/remote-gate.ts.
	const remoteRefusal = refuseAnonymousRemoteCall(event)
	if (remoteRefusal) return remoteRefusal
	if (event.isRemoteRequest) return resolve(event)

	const provisioned = await isProvisioned()

	// Setup gate: until a password is set, every request lands on /setup.
	if (!provisioned) {
		if (event.url.pathname !== '/setup' && !event.url.pathname.startsWith('/_app') && !event.url.pathname.startsWith('/favicon')) {
			throw redirect(303, '/setup')
		}
		return resolve(event)
	}

	// Once provisioned, /setup is no longer reachable.
	if (event.url.pathname === '/setup') {
		throw redirect(303, event.locals.authenticated ? '/' : '/login')
	}

	if (!event.locals.authenticated && !isPublicPath(event.url.pathname)) {
		throw redirect(303, '/login')
	}

	if (event.locals.authenticated && event.url.pathname === '/login') {
		throw redirect(303, '/')
	}

	return resolve(event)
}

/**
 * Production "Internal Error" 500 responses hide the underlying error message from the
 * client by design — logging the full error here is what surfaces it in our server logs
 * so we can actually diagnose remote-function failures from prod traffic.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const url = event.url?.pathname ?? '<unknown>'
	const errMsg = error instanceof Error ? error.message : String(error)
	const errStack = error instanceof Error ? error.stack : undefined
	logger.error(`[hooks/handleError] ${status} ${event.request?.method ?? 'GET'} ${url}: ${message}`, {
		cause: errMsg,
		stack: errStack,
	})
	return { message: message ?? 'Internal Error' }
}
