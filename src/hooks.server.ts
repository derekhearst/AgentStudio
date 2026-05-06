import { redirect, type Handle, type HandleServerError } from '@sveltejs/kit'
import { and, arrayContains, sql } from 'drizzle-orm'
import { getSessionUser, isProvisioned } from '$lib/auth/auth.server'
import { db, ensureDatabaseReady } from '$lib/db.server'
import { skills } from '$lib/skills/skills.schema'

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
		console.error('Failed to cleanup legacy capability group skills:', e)
	}
}

// `/api/webhooks` is unauthenticated by design — third-party providers (GitHub, …) POST
// here without session cookies. The handlers verify provider signatures themselves so the
// path-level skip is safe; never broaden this prefix without an explicit signature check.
const PUBLIC_PATH_PREFIXES = ['/login', '/setup', '/demo', '/api/webhooks']

function isPublicPath(pathname: string) {
	if (pathname.startsWith('/_app') || pathname.startsWith('/favicon')) {
		return true
	}

	return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export const handle: Handle = async ({ event, resolve }) => {
	await ensureDatabaseReady()
	await cleanupLegacyCapabilitySkills()

	const user = await getSessionUser(event.cookies)
	event.locals.user = user
	event.locals.authenticated = user !== null

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
	console.error(
		`[hooks/handleError] ${status} ${event.request?.method ?? 'GET'} ${url}: ${message}\n  cause: ${errMsg}\n${errStack ?? ''}`,
	)
	return { message: message ?? 'Internal Error' }
}
