import { json, type RequestHandler } from '@sveltejs/kit'
import { checkAndRunAutomations } from '$lib/automations/engine'
import { runWorkspaceGc } from '$lib/workspace/gc.server'
import { backfillSkillEmbeddings } from '$lib/skills/skills.server'
import { logger } from '$lib/observability/logger'

function hasCronAccess(request: Request) {
	const expected = process.env.CRON_SECRET?.trim()
	if (!expected) return true
	const auth = request.headers.get('authorization')
	if (!auth) return false
	const token = auth.replace(/^Bearer\s+/i, '').trim()
	return token === expected
}

export const POST: RequestHandler = async ({ request }) => {
	if (!hasCronAccess(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	const now = new Date()
	const automations = await checkAndRunAutomations(now)

	// Workspace GC: tick at most once per 60 minutes (last-run gate is on disk via mtime check
	// would over-engineer; this is fine as a per-cron-invocation pass).
	const sandboxRoot = process.env.SANDBOX_WORKSPACE
	let workspace: Awaited<ReturnType<typeof runWorkspaceGc>> | null = null
	if (sandboxRoot) {
		try {
			workspace = await runWorkspaceGc({ sandboxRoot, now })
		} catch (err) {
			logger.error('[cron] workspace GC failed', { err })
		}
	}

	// Skill embedding backfill (Phase 4 of #4): catches skills inserted via raw SQL or
	// migration paths that bypassed createSkill's automatic embedding refresh.
	let skillEmbeddings: Awaited<ReturnType<typeof backfillSkillEmbeddings>> | null = null
	try {
		skillEmbeddings = await backfillSkillEmbeddings(50)
	} catch (err) {
		logger.error('[cron] skill embedding backfill failed', { err })
	}

	return json({ automations, workspace, skillEmbeddings })
}
