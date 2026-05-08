/**
 * Shared ownership / authorization helpers.
 *
 * Replaces the recurring pattern in domain `*.remote.ts` and `*.server.ts` files:
 *
 *   if (!entity) throw new Error(`X not found`)
 *   if (entity.userId !== userId) throw new Error('Not authorized')
 *
 * The throwing variant is intended for remote functions and command handlers
 * where errors propagate to the client. Tool implementations that need to return
 * a `{ ok: false, error }` shape should use `checkOwnership` instead.
 */

type Owned = { userId: string }

/**
 * Asserts the entity exists and is owned by `userId`. Throws on failure.
 *
 * @param entity     The fetched row (or null/undefined if not found).
 * @param userId     The current user's ID.
 * @param entityName Human-readable name used in the not-found error message.
 * @returns          The entity, narrowed to non-null.
 */
export function ensureOwnership<T extends Owned>(
	entity: T | null | undefined,
	userId: string,
	entityName: string,
): T {
	if (!entity) throw new Error(`${entityName} not found`)
	if (entity.userId !== userId) throw new Error('Not authorized')
	return entity
}

/**
 * Non-throwing variant. Returns a discriminated result so tool handlers can
 * surface the error to the model without raising.
 */
export function checkOwnership<T extends Owned>(
	entity: T | null | undefined,
	userId: string,
	entityName: string,
): { ok: true; entity: T } | { ok: false; error: string } {
	if (!entity) return { ok: false, error: `${entityName} not found` }
	if (entity.userId !== userId) return { ok: false, error: `${entityName} not accessible` }
	return { ok: true, entity }
}
