import postgres from 'postgres'

const dbUrl = (process.env.DATABASE_URL || '').replace(/^"|"$/g, '')
const sql = postgres(dbUrl)
const r =
	await sql`SELECT id, role, tool_calls, cost, ttft_ms, total_ms, tokens_per_sec FROM messages WHERE conversation_id = '3dfe1999-4a8e-4d29-8666-e1c533687f2d' ORDER BY created_at`
console.log(
	JSON.stringify(
		r.map((m) => ({
			role: m.role,
			tc_count: m.tool_calls?.length,
			tc_names: m.tool_calls?.map((t: any) => t.name),
			cost: m.cost,
			ttftMs: m.ttft_ms,
			totalMs: m.total_ms,
			tokPerSec: m.tokens_per_sec,
		})),
		null,
		2,
	),
)
await sql.end()
process.exit(0)
