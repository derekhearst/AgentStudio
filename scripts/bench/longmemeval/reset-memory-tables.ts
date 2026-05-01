import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL!)

async function main() {
	// Drop new memory_* tables and KG tables if they exist (they were partially created)
	await sql.unsafe(`DROP TABLE IF EXISTS memory_kg_relations CASCADE`)
	await sql.unsafe(`DROP TABLE IF EXISTS memory_kg_entities CASCADE`)
	await sql.unsafe(`DROP TABLE IF EXISTS memory_drawers CASCADE`)
	await sql.unsafe(`DROP TABLE IF EXISTS memory_closets CASCADE`)
	// Truncate the legacy rooms/wings so the ALTER TABLE ADD COLUMN NOT NULL succeeds
	await sql.unsafe(`TRUNCATE TABLE memory_rooms, memory_wings CASCADE`)
	// Rewind last 2 migration history entries so 0011/0012 reapply
	const journal = await sql
		.unsafe(`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5`)
		.catch(() => [])
	console.log('journal tail:', journal)
	await sql
		.unsafe(
			`DELETE FROM drizzle.__drizzle_migrations WHERE id IN (SELECT id FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 2)`,
		)
		.catch((e) => console.error('hist:', e.message))
	console.log('reset complete')
	await sql.end()
}

void main()
