import { expect, test } from '@playwright/test'
import { getSql, uniquePrefix } from './helpers'

/**
 * Wave 5 #20 phase 4 — operational metrics sampler invariants.
 *
 * The sampler in src/lib/observability/metrics.server.ts pulls in $env via db.server, so we
 * exercise the SCHEMA contract here:
 *   - recordMetric round-trips with the right (metric, dimension, value, measured_at) shape
 *   - listLatestMetrics distinct-on (metric, dimension) returns only the freshest sample
 *   - dimension jsonb containment query (`@>`) narrows correctly for timeseries lookups
 *   - the sampler queries (queue depth, review inbox, runs) compose against the production
 *     schema without errors
 */

test.describe('observability/metrics — recordMetric + listLatest contract', () => {
	test('metric row stores metric/dimension/value/measured_at and round-trips', async () => {
		const prefix = uniquePrefix('metric-roundtrip')
		const sql = getSql()
		try {
			const [row] = await sql<{ metric: string; dimension: Record<string, unknown>; value: string; measured_at: Date }[]>`
				insert into operational_metrics (metric, dimension, value, measured_at)
				values (
					${`${prefix}.queue.depth.pending`},
					${sql.json({ type: 'memory_mine', queue: 'background' })},
					'42',
					now() - interval '1 minute'
				)
				returning metric, dimension, value::text as value, measured_at
			`
			expect(row.metric).toBe(`${prefix}.queue.depth.pending`)
			expect(row.dimension).toEqual({ type: 'memory_mine', queue: 'background' })
			expect(row.value).toBe('42.000000')
			expect(row.measured_at).toBeInstanceOf(Date)
		} finally {
			await sql`delete from operational_metrics where metric like ${`${prefix}%`}`
		}
	})

	test('distinct-on (metric, dimension) returns only the freshest sample per dimension key', async () => {
		const prefix = uniquePrefix('metric-latest')
		const sql = getSql()
		try {
			// Three samples for the SAME (metric, dimension) at three different timestamps.
			await sql`
				insert into operational_metrics (metric, dimension, value, measured_at) values
				(${`${prefix}.queue.depth.pending`}, ${sql.json({ type: 'mine' })}, '10', now() - interval '15 minutes'),
				(${`${prefix}.queue.depth.pending`}, ${sql.json({ type: 'mine' })}, '12', now() - interval '10 minutes'),
				(${`${prefix}.queue.depth.pending`}, ${sql.json({ type: 'mine' })}, '15', now() - interval '5 minutes')
			`
			// Mirror the listLatestMetrics distinct-on shape.
			const rows = await sql<{ value: string }[]>`
				select distinct on (metric, dimension) value::text as value
				from operational_metrics
				where metric = ${`${prefix}.queue.depth.pending`}
				order by metric, dimension, measured_at desc
			`
			expect(rows.length).toBe(1)
			expect(rows[0].value).toBe('15.000000')
		} finally {
			await sql`delete from operational_metrics where metric like ${`${prefix}%`}`
		}
	})

	test('distinct-on splits across multiple dimension keys', async () => {
		const prefix = uniquePrefix('metric-multi-dim')
		const sql = getSql()
		try {
			await sql`
				insert into operational_metrics (metric, dimension, value, measured_at) values
				(${`${prefix}.queue.depth.pending`}, ${sql.json({ type: 'mine' })}, '10', now() - interval '5 minutes'),
				(${`${prefix}.queue.depth.pending`}, ${sql.json({ type: 'eval' })}, '7', now() - interval '5 minutes'),
				(${`${prefix}.queue.depth.pending`}, ${sql.json({ type: 'gc' })}, '0', now() - interval '5 minutes')
			`
			const rows = await sql<{ value: string; dimension: Record<string, unknown> }[]>`
				select distinct on (metric, dimension) value::text as value, dimension
				from operational_metrics
				where metric = ${`${prefix}.queue.depth.pending`}
				order by metric, dimension, measured_at desc
			`
			expect(rows.length).toBe(3)
			expect(rows.map((r) => r.dimension.type).sort()).toEqual(['eval', 'gc', 'mine'])
		} finally {
			await sql`delete from operational_metrics where metric like ${`${prefix}%`}`
		}
	})

	test('jsonb containment (@>) filters timeseries to a specific dimension subset', async () => {
		const prefix = uniquePrefix('metric-jsonb')
		const sql = getSql()
		try {
			await sql`
				insert into operational_metrics (metric, dimension, value, measured_at) values
				(${`${prefix}.queue.depth.failed_recent`}, ${sql.json({ type: 'memory_mine', queue: 'background', window: '1h' })}, '3', now() - interval '5 minutes'),
				(${`${prefix}.queue.depth.failed_recent`}, ${sql.json({ type: 'evaluation_run', queue: 'evaluations', window: '1h' })}, '1', now() - interval '5 minutes'),
				(${`${prefix}.queue.depth.failed_recent`}, ${sql.json({ type: 'memory_mine', queue: 'background', window: '6h' })}, '8', now() - interval '5 minutes')
			`
			// Containment: only the rows whose dimension contains {type: 'memory_mine'}.
			const rows = await sql<{ value: string; dimension: Record<string, unknown> }[]>`
				select value::text as value, dimension
				from operational_metrics
				where metric = ${`${prefix}.queue.depth.failed_recent`}
				and dimension @> '{"type": "memory_mine"}'::jsonb
				order by measured_at desc
			`
			expect(rows.length).toBe(2)
			expect(rows.every((r) => r.dimension.type === 'memory_mine')).toBe(true)
		} finally {
			await sql`delete from operational_metrics where metric like ${`${prefix}%`}`
		}
	})
})

test.describe('observability/metrics — sampler queries compose against schema', () => {
	test('queue depth aggregate query runs against production jobs table', async () => {
		const sql = getSql()
		// Just exercise the query the sampler runs — the result count depends on real queue
		// state, but the query itself must be valid SQL against the live schema.
		const rows = await sql<{ status: string; type: string; queue: string; count: number }[]>`
			select status::text as status, type, queue, count(*)::int as count
			from jobs
			where status in ('pending', 'leased', 'running', 'retry_wait')
			group by status, type, queue
		`
		// Each row must carry the four selected columns.
		for (const r of rows) {
			expect(typeof r.status).toBe('string')
			expect(typeof r.type).toBe('string')
			expect(typeof r.queue).toBe('string')
			expect(typeof r.count).toBe('number')
		}
	})

	test('review inbox open by severity aggregate runs against schema', async () => {
		const sql = getSql()
		const rows = await sql<{ severity: string; count: number }[]>`
			select severity::text as severity, count(*)::int as count
			from review_items
			where status in ('open', 'in_progress')
			group by severity
		`
		for (const r of rows) {
			expect(['info', 'warning', 'critical']).toContain(r.severity)
			expect(typeof r.count).toBe('number')
		}
	})

	test('runs terminal-state aggregate uses finished_at + state enum cast', async () => {
		const sql = getSql()
		const rows = await sql<{ state: string; count: number }[]>`
			select state::text as state, count(*)::int as count
			from chat_runs
			where finished_at >= now() - interval '24 hours'
			and state in ('completed', 'failed', 'canceled')
			group by state
		`
		for (const r of rows) {
			expect(['completed', 'failed', 'canceled']).toContain(r.state)
			expect(typeof r.count).toBe('number')
		}
	})
})
