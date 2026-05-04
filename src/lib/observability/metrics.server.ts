import { and, desc, eq, sql as drizzleSql } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { operationalMetrics, type OperationalMetricRow } from './observability.schema'

/**
 * Wave 5 #20 phase 4 — operational metrics writer + sampler.
 *
 * Two surfaces:
 *
 *   recordMetric({metric, dimension?, value}) — append-only writer for any domain that wants
 *      to land a sample. Used by sampler + jobs failure path + memory mining throughput etc.
 *
 *   runMetricsSample() — periodic snapshot of the platform's "vital signs":
 *      queue.depth.pending / leased / retry_wait / failed_recent (last hour) per type
 *      review_inbox.open per severity
 *      runs.completed_24h / failed_24h
 *
 * The writer is best-effort (logs and swallows). The sampler is called from a scheduled job
 * (`metrics_sample`) every 5 minutes; admins read the recent rows via `/review/health`.
 *
 * The metric naming convention is dot-separated lowercase nouns:
 *   queue.depth.pending           (count of jobs in pending state)
 *   queue.depth.failed_recent     (count of jobs that failed in the last hour)
 *   review_inbox.open             (count of open review items)
 *   runs.completed_24h            (count of runs completed in the last 24h)
 *   runs.failed_24h               (count of runs that hit the failed terminal state)
 */

export type RecordMetricInput = {
	metric: string
	dimension?: Record<string, unknown>
	value: number
	measuredAt?: Date
}

export async function recordMetric(input: RecordMetricInput): Promise<OperationalMetricRow | null> {
	try {
		const [row] = await db
			.insert(operationalMetrics)
			.values({
				metric: input.metric,
				dimension: input.dimension ?? {},
				value: String(input.value),
				measuredAt: input.measuredAt ?? new Date(),
			})
			.returning()
		return row
	} catch (err) {
		console.warn('[metrics] recordMetric failed (non-fatal)', err)
		return null
	}
}

/**
 * Write all current platform vital signs in one shot. Designed to be called every ~5 minutes
 * from a scheduled job. All writes are best-effort — a single failed write doesn't abort the
 * remaining samples.
 *
 * Returns the number of metric rows written so the caller (job handler) can put a count in
 * `jobs.result` for the admin dashboard.
 */
export async function runMetricsSample(): Promise<{ written: number }> {
	const measuredAt = new Date()
	let written = 0

	// Queue depth by status × type. Job statuses are pending / leased / running / retry_wait /
	// completed / failed / canceled — we only sample the "in-flight" subset since terminal
	// counts are cheap to compute via a 24h window query.
	try {
		const rows = await db.execute<{ status: string; type: string; queue: string; count: number }>(drizzleSql`
			select status::text as status, type, queue, count(*)::int as count
			from jobs
			where status in ('pending', 'leased', 'running', 'retry_wait')
			group by status, type, queue
		`)
		for (const r of rows as unknown as Array<{ status: string; type: string; queue: string; count: number }>) {
			await recordMetric({
				metric: `queue.depth.${r.status}`,
				dimension: { type: r.type, queue: r.queue },
				value: Number(r.count),
				measuredAt,
			})
			written++
		}
	} catch (err) {
		console.warn('[metrics] queue.depth sample failed', err)
	}

	// Failed-recent rolling window — jobs that failed in the last hour. Use a fixed window
	// rather than "since last sample" so each row stands alone for the dashboard.
	try {
		const rows = await db.execute<{ type: string; queue: string; count: number }>(drizzleSql`
			select type, queue, count(*)::int as count
			from jobs
			where status = 'failed'
			and finished_at >= now() - interval '1 hour'
			group by type, queue
		`)
		for (const r of rows as unknown as Array<{ type: string; queue: string; count: number }>) {
			await recordMetric({
				metric: 'queue.depth.failed_recent',
				dimension: { type: r.type, queue: r.queue, window: '1h' },
				value: Number(r.count),
				measuredAt,
			})
			written++
		}
	} catch (err) {
		console.warn('[metrics] queue.depth.failed_recent sample failed', err)
	}

	// Review inbox open count by severity.
	try {
		const rows = await db.execute<{ severity: string; count: number }>(drizzleSql`
			select severity::text as severity, count(*)::int as count
			from review_items
			where status in ('open', 'in_progress')
			group by severity
		`)
		for (const r of rows as unknown as Array<{ severity: string; count: number }>) {
			await recordMetric({
				metric: 'review_inbox.open',
				dimension: { severity: r.severity },
				value: Number(r.count),
				measuredAt,
			})
			written++
		}
	} catch (err) {
		console.warn('[metrics] review_inbox.open sample failed', err)
	}

	// Runs in the last 24h by terminal state.
	try {
		const rows = await db.execute<{ state: string; count: number }>(drizzleSql`
			select state::text as state, count(*)::int as count
			from chat_runs
			where finished_at >= now() - interval '24 hours'
			and state in ('completed', 'failed', 'canceled')
			group by state
		`)
		for (const r of rows as unknown as Array<{ state: string; count: number }>) {
			await recordMetric({
				metric: `runs.${r.state}_24h`,
				dimension: {},
				value: Number(r.count),
				measuredAt,
			})
			written++
		}
	} catch (err) {
		console.warn('[metrics] runs.terminal_24h sample failed', err)
	}

	return { written }
}

/**
 * Read the most recent value for each (metric, dimension) pair so the dashboard can render a
 * point-in-time snapshot. Returns up to `limit` rows ordered by metric name + measuredAt desc.
 */
export async function listLatestMetrics(limit = 200): Promise<OperationalMetricRow[]> {
	// Distinct on (metric, dimension::text) keeps only the freshest sample per dimension key.
	return db.execute<OperationalMetricRow>(drizzleSql`
		select distinct on (metric, dimension)
			id, metric, dimension, value, measured_at as "measuredAt"
		from operational_metrics
		where measured_at >= now() - interval '24 hours'
		order by metric, dimension, measured_at desc
		limit ${limit}
	`) as unknown as Promise<OperationalMetricRow[]>
}

export type MetricSnapshotPoint = {
	value: number
	measuredAt: string // ISO
}

export type MetricSnapshotEntry = {
	metric: string
	dimension: Record<string, unknown>
	latest: MetricSnapshotPoint
	series: MetricSnapshotPoint[] // up to ~288 points (24h × 5min) per (metric, dimension)
}

/**
 * Read every sample in the last `hours` window in one round-trip and group by (metric,
 * dimension) so the dashboard renders a snapshot + per-row sparkline without N+1 queries.
 *
 * Counter metrics like `jobs.lifecycle.completed` arrive as one row per finish event — the
 * page renders those as a count over time. Gauge metrics like `queue.depth.pending` arrive
 * as one row per sampler tick — the page renders those as the value over time.
 */
export async function listMetricSnapshotsWithSeries(hours = 24): Promise<MetricSnapshotEntry[]> {
	const rows = await db.execute<{
		metric: string
		dimension: Record<string, unknown>
		value: string
		measured_at: Date
	}>(drizzleSql`
		select metric, dimension, value::text as value, measured_at
		from operational_metrics
		where measured_at >= now() - interval '${drizzleSql.raw(String(hours))} hours'
		order by metric, dimension, measured_at asc
	`)

	const groups = new Map<string, MetricSnapshotEntry>()
	for (const r of rows as unknown as Array<{ metric: string; dimension: Record<string, unknown>; value: string; measured_at: Date }>) {
		const key = `${r.metric}::${JSON.stringify(r.dimension)}`
		const point: MetricSnapshotPoint = {
			value: parseFloat(r.value),
			measuredAt: new Date(r.measured_at).toISOString(),
		}
		const existing = groups.get(key)
		if (existing) {
			existing.series.push(point)
			// Series is appended in chronological order; latest is always the last point.
			existing.latest = point
		} else {
			groups.set(key, {
				metric: r.metric,
				dimension: r.dimension,
				latest: point,
				series: [point],
			})
		}
	}
	return [...groups.values()]
}

/**
 * Read the timeseries for a single metric so the dashboard can render a sparkline.
 * Optional dimension filter narrows to a specific (type, queue, severity, etc.) combo.
 */
export async function listMetricTimeseries(
	metric: string,
	dimensionFilter: Record<string, unknown> = {},
	hours = 24,
): Promise<OperationalMetricRow[]> {
	// Build a `dimension @> '{...}'` jsonb containment match if a filter is provided.
	const where = [
		eq(operationalMetrics.metric, metric),
		drizzleSql`${operationalMetrics.measuredAt} >= now() - interval '${drizzleSql.raw(String(hours))} hours'`,
	]
	if (Object.keys(dimensionFilter).length > 0) {
		where.push(drizzleSql`${operationalMetrics.dimension} @> ${JSON.stringify(dimensionFilter)}::jsonb`)
	}
	return db
		.select()
		.from(operationalMetrics)
		.where(and(...where))
		.orderBy(desc(operationalMetrics.measuredAt))
		.limit(500)
}
