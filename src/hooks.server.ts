import { redirect, type Handle } from '@sveltejs/kit'
import { and, arrayContains, sql } from 'drizzle-orm'
import { ensureAuthBootstrap, getSessionUser } from '$lib/auth/auth.server'
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

const PUBLIC_PATH_PREFIXES = ['/login', '/demo', '/icon-preview']
const ADMIN_PATH_PREFIXES = ['/users']

function isPublicPath(pathname: string) {
	if (pathname.startsWith('/_app') || pathname.startsWith('/favicon')) {
		return true
	}

	return PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

export const handle: Handle = async ({ event, resolve }) => {
	await ensureDatabaseReady()
	await cleanupLegacyCapabilitySkills()
	await ensureAuthBootstrap(event.url.origin)

	const user = await getSessionUser(event.cookies)
	event.locals.user = user
	event.locals.authenticated = user !== null

	if (!event.locals.authenticated && !isPublicPath(event.url.pathname)) {
		throw redirect(303, '/login')
	}

	if (event.locals.authenticated && event.url.pathname === '/login') {
		throw redirect(303, '/')
	}

	if (
		event.locals.authenticated &&
		event.locals.user?.role !== 'admin' &&
		ADMIN_PATH_PREFIXES.some((prefix) => event.url.pathname === prefix || event.url.pathname.startsWith(`${prefix}/`))
	) {
		throw redirect(303, '/')
	}

	return resolve(event)
}
