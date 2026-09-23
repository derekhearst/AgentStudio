import { timingSafeEqual } from 'node:crypto'

/**
 * Who may fire `POST /api/cron` — the external trigger for the same tick the in-process
 * scheduler runs every minute (useful when the scheduler is off, `JOBS_SCHEDULER_ENABLED=0`,
 * and an outside cron drives the instance instead).
 *
 * Two callers qualify:
 *   - a signed-in session, for a person pressing it by hand or a spec;
 *   - a request carrying `Authorization: Bearer <CRON_SECRET>`, for a scheduler that has no
 *     session to offer.
 *
 * The bearer path used to be unreachable: `/api/cron` was not a public path, so the hook
 * answered every cookieless request with `303 → /login` before this check ran, and an
 * external cron configured exactly as documented silently never ticked. The path is public
 * now, which is only safe because this check fails closed — no secret configured means no
 * bearer access at all. (It used to be the reverse, `if (!secret) return true`, which was
 * harmless only while the hook stood in front of it.)
 *
 * Pure, so the rule is testable without a server; the route passes in what it read.
 */
export function hasCronAccess(input: {
	authenticated: boolean
	authorization: string | null
	secret: string | undefined
}): boolean {
	if (input.authenticated) return true
	if (!input.secret) return false
	const match = /^Bearer\s+(.+)$/i.exec(input.authorization?.trim() ?? '')
	if (!match) return false
	const given = Buffer.from(match[1].trim())
	const expected = Buffer.from(input.secret)
	// Constant-time on equal lengths; a length mismatch is already a no, and says nothing the
	// attacker did not choose.
	return given.length === expected.length && timingSafeEqual(given, expected)
}
