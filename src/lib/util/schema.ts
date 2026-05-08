/**
 * Shared zod primitives for remote function and API input validation.
 *
 * Replaces ~89 occurrences of `z.string().trim().min(1)` and ~137 ad-hoc UUID/int
 * schemas scattered across `*.remote.ts` files. Import these instead of redefining
 * inline, so validation rules stay consistent across domains.
 *
 * Length-bounded variants are provided for common cases (short labels, prompts,
 * descriptions). For one-off limits, compose directly: `nonEmptyString.max(200)`.
 */

import { z } from 'zod'

/** Trimmed, non-empty string. The base shape used everywhere we accept user text. */
export const nonEmptyString = z.string().trim().min(1)

/** Short labels: titles, names, agent IDs in string form, etc. */
export const shortLabel = nonEmptyString.max(120)

/** Medium-length text: descriptions, summaries. */
export const mediumText = nonEmptyString.max(2000)

/** UUID v4 string. */
export const uuidString = z.string().uuid()

/** Optional UUID — accepts undefined or a valid UUID. */
export const optionalUuid = uuidString.optional()

/** Nullable + optional UUID — accepts null, undefined, or a valid UUID. */
export const nullableUuid = uuidString.nullable().optional()

/** Positive integer (>= 1). */
export const positiveInt = z.number().int().min(1)

/** Non-negative integer (>= 0). */
export const nonNegativeInt = z.number().int().min(0)

/** Standard pagination input shape. */
export const paginationInput = z.object({
	limit: z.number().int().min(1).max(200).optional(),
	offset: z.number().int().min(0).optional(),
})

/** A `record<string, unknown>` for opaque metadata blobs. */
export const metadataRecord = z.record(z.string(), z.unknown())
