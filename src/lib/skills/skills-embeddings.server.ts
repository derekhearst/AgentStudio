/**
 * Skill description-embedding maintenance.
 *
 * Skills carry a persisted `description_embedding` vector so the relevance
 * ranker (`listRelevantSkillSummaries`) can do cosine search over a query
 * embedding. The two helpers here keep that vector in sync:
 *   - `refreshSkillEmbedding` — write the embedding for a single skill row.
 *   - `backfillSkillEmbeddings` — batch-embed every enabled skill that's still
 *     missing a vector (e.g. inserted by raw SQL or a migration that bypassed
 *     `createSkill`).
 *
 * Both swallow embedding-API errors and log them; an LLM API outage must not
 * block CRUD or boot.
 */

import { and, eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { skills } from '$lib/skills/skills.schema'
import { embed, embedOne } from '$lib/memory/embeddings.server'
import { logger } from '$lib/observability/logger'
import { isSystemSkillId } from './skills-system.server'

const SKILL_EMBED_TEXT = (name: string, description: string) => `${name}\n${description}`.slice(0, 2000)

/**
 * Compute and persist `description_embedding` for a single skill row. Idempotent: writes the
 * vector + timestamp; safe to call repeatedly. Failures (e.g. embedding API down) are logged
 * and swallowed so they never block CRUD.
 */
export async function refreshSkillEmbedding(skillId: string): Promise<void> {
	if (isSystemSkillId(skillId)) return // virtual system skill has no DB row to update
	try {
		const [row] = await db
			.select({ name: skills.name, description: skills.description })
			.from(skills)
			.where(eq(skills.id, skillId))
			.limit(1)
		if (!row) return
		const vector = await embedOne(SKILL_EMBED_TEXT(row.name, row.description))
		await db
			.update(skills)
			.set({ descriptionEmbedding: vector, descriptionEmbeddedAt: new Date() })
			.where(eq(skills.id, skillId))
	} catch (err) {
		logger.warn('[skills] refreshSkillEmbedding failed', { err })
	}
}

/**
 * Backfill embeddings for every enabled skill that doesn't have one yet. Runs in batches.
 * Returns the count of newly-embedded rows.
 */
export async function backfillSkillEmbeddings(limit = 50): Promise<{ embedded: number }> {
	try {
		const pending = await db
			.select({ id: skills.id, name: skills.name, description: skills.description })
			.from(skills)
			.where(and(eq(skills.enabled, true), drizzleSql`${skills.descriptionEmbedding} is null`))
			.limit(limit)
		if (pending.length === 0) return { embedded: 0 }

		const texts = pending.map((s) => SKILL_EMBED_TEXT(s.name, s.description))
		const vectors = await embed(texts)
		const now = new Date()
		for (let i = 0; i < pending.length; i++) {
			const v = vectors[i]
			if (!v) continue
			await db
				.update(skills)
				.set({ descriptionEmbedding: v, descriptionEmbeddedAt: now })
				.where(eq(skills.id, pending[i].id))
		}
		return { embedded: vectors.filter(Boolean).length }
	} catch (err) {
		logger.warn('[skills] backfillSkillEmbeddings failed', { err })
		return { embedded: 0 }
	}
}
