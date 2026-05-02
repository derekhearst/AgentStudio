import postgres from 'postgres'

const sql = postgres('postgresql://derek:d8ACeA2x9oW%23oP@192.168.0.2:5432/AGENTSTUDIO')
const rows = await sql`SELECT role, LEFT(content,60) as content, metadata, created_at FROM messages ORDER BY created_at DESC LIMIT 12`
console.log(JSON.stringify(rows, null, 2))
await sql.end()
