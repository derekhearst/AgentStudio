import { redirect, type Handle, type HandleServerError } from '@sveltejs/kit'
import { dev } from '$app/environment'
import { and, arrayContains, sql } from 'drizzle-orm'
import { findOwnerIdentity, getSessionUser } from '$lib/auth/auth.server'
import { authGateRedirect } from '$lib/auth/gate.server'
import { refuseAnonymousRemoteCall } from '$lib/auth/remote-gate.server'
import { authDevBypassEnabled } from '$lib/auth/dev-bypass'
import { db, ensureDatabaseReady } from '$lib/db.server'
import { skills } from '$lib/skills/skills.schema'
import { logger } from '$lib/observability/logger'

// Dev-mode auth bypass. Active only in a dev build (`vite dev`), with NODE_ENV !== 'production'
// AND AUTH_DEV_BYPASS=1 — a production build ignores the variable (see dev-bypass.ts).
// When active, requests without a session cookie are auto-attached to the owner, skipping
// the /login redirect — for driving the app from a viewer or agent that cannot (or must not)
// type the password. It attaches only to a real owner (one with a password): on an instance
// without one it does nothing and the setup gate applies. To get a local owner without a
// browser, use `bun run db:bootstrap`.
const AUTH_DEV_BYPASS = authDevBypassEnabled({ devBuild: dev, env: process.env })
if (AUTH_DEV_BYPASS) {
	logger.warn('[hooks] AUTH_DEV_BYPASS=1 — anonymous requests will auto-attach to the singleton user. Set AUTH_DEV_BYPASS=0 in .env to disable.')
}
let warnedAboutBypass = false

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

export const handle: Handle = async ({ event, resolve }) => {
	await ensureDatabaseReady()
	await cleanupLegacyCapabilitySkills()

	let user = await getSessionUser(event.cookies)
	if (!user && AUTH_DEV_BYPASS) {
		const fallback = await findOwnerIdentity()
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

	// Setup gate (no owner yet: everything goes to /setup) and the page gate (no session:
	// everything but the public paths goes to /login). Rules in src/lib/auth/gate.ts.
	const gateRedirect = await authGateRedirect(event)
	if (gateRedirect) throw redirect(303, gateRedirect)

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
