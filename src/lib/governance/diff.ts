/**
 * Wave 3 #12 phase 1 — pure diff helper for the audit log summary.
 *
 * No DB / SvelteKit deps so unit tests can import it directly. The server-side helper module
 * re-exports this so callers see one canonical name.
 */

export function diffTopLevelKeys(
	before: Record<string, unknown> | null | undefined,
	after: Record<string, unknown> | null | undefined,
): string[] {
	const b = before ?? {}
	const a = after ?? {}
	const keys = new Set([...Object.keys(b), ...Object.keys(a)])
	const changed: string[] = []
	for (const k of keys) {
		try {
			if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) changed.push(k)
		} catch {
			changed.push(k)
		}
	}
	return changed
}
