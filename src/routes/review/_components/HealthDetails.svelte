<script lang="ts">
	import Sparkline from '$lib/ui/Sparkline.svelte';
	import type { getOperationalSnapshotQuery } from '$lib/observability/review.remote';

	type Result = Awaited<ReturnType<typeof getOperationalSnapshotQuery>>;
	type Entry = Extract<Result, { adminOnly: false }>['entries'][number];

	let { entries }: { entries: Entry[] } = $props();

	function fmtAge(d: Date | string) {
		const now = Date.now();
		const t = new Date(d).getTime();
		const ms = Math.max(0, now - t);
		if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
		if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
		return `${Math.round(ms / 3_600_000)}h ago`;
	}

	function dimensionString(dim: Record<string, unknown>): string {
		const keys = Object.keys(dim);
		if (keys.length === 0) return '';
		return keys.map((k) => `${k}=${dim[k]}`).join(' · ');
	}

	function metricGroup(metric: string): string {
		const dot = metric.indexOf('.');
		if (dot === -1) return metric;
		return metric.slice(0, dot);
	}

	const grouped = $derived.by(() => {
		const map = new Map<string, Entry[]>();
		for (const row of entries) {
			const g = metricGroup(row.metric);
			const list = map.get(g) ?? [];
			list.push(row);
			map.set(g, list);
		}
		return [...map.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([group, rows]) => ({
				group,
				rows: rows.sort((a, b) => {
					if (a.metric !== b.metric) return a.metric.localeCompare(b.metric);
					return JSON.stringify(a.dimension).localeCompare(JSON.stringify(b.dimension));
				}),
			}));
	});

	function sparklineTone(metric: string): { stroke: string; fill: string } {
		if (metric.endsWith('.duration_ms')) return { stroke: 'stroke-info text-info', fill: 'fill-info/10' };
		if (metric.includes('failed')) return { stroke: 'stroke-error text-error', fill: 'fill-error/10' };
		if (metric.startsWith('review_inbox')) return { stroke: 'stroke-warning text-warning', fill: 'fill-warning/10' };
		if (metric.includes('completed')) return { stroke: 'stroke-success text-success', fill: 'fill-success/10' };
		return { stroke: 'stroke-primary text-primary', fill: 'fill-primary/10' };
	}

	function fmtValue(metric: string, value: number | string): string {
		const num = typeof value === 'number' ? value : parseFloat(String(value));
		if (Number.isNaN(num)) return String(value);
		if (metric.endsWith('.duration_ms')) {
			if (num < 1000) return `${Math.round(num)}ms`;
			const s = num / 1000;
			if (s < 60) return `${s.toFixed(1)}s`;
			const m = Math.floor(s / 60);
			const rs = Math.round(s - m * 60);
			return `${m}m ${rs}s`;
		}
		return Math.round(num).toString();
	}
</script>

{#if entries.length === 0}
	<div class="rounded-xl border border-base-300/60 bg-base-200/30 p-6 text-center text-sm text-base-content/55">
		No metric samples yet. The 5-minute sampler runs after the first scheduled tick — wait
		up to ~5 minutes for the first row, or trigger an enqueue manually via
		<code>metrics_sample</code> in the jobs admin.
	</div>
{:else}
	<div class="space-y-3">
		{#each grouped as group (group.group)}
			<div class="rounded-xl border border-base-300/60 bg-base-100">
				<div class="flex items-center justify-between border-b border-base-300/40 px-3 py-2">
					<h3 class="font-mono text-sm font-semibold">{group.group}</h3>
					<span class="badge badge-sm badge-ghost">{group.rows.length}</span>
				</div>
				<div class="overflow-x-auto p-2">
					<table class="w-full text-xs">
						<thead>
							<tr class="text-left text-[10px] uppercase tracking-wide text-base-content/55">
								<th class="py-1 pr-2">Metric</th>
								<th class="py-1 pr-2">Dimension</th>
								<th class="py-1 pr-2 text-right">Latest</th>
								<th class="py-1 pr-2">Trend (24h)</th>
								<th class="py-1 pr-2 text-right">Measured</th>
							</tr>
						</thead>
						<tbody>
							{#each group.rows as entry (entry.metric + JSON.stringify(entry.dimension))}
								{@const tone = sparklineTone(entry.metric)}
								<tr class="border-t border-base-300/40">
									<td class="py-1.5 pr-2 font-mono">{entry.metric}</td>
									<td class="py-1.5 pr-2 font-mono text-[10px] text-base-content/70">
										{dimensionString(entry.dimension)}
									</td>
									<td class="py-1.5 pr-2 text-right font-mono font-semibold">
										{fmtValue(entry.metric, entry.latest.value)}
									</td>
									<td class="py-1.5 pr-2">
										<Sparkline
											points={entry.series}
											strokeClass={tone.stroke}
											fillClass={tone.fill}
											width={120}
											height={20}
										/>
									</td>
									<td class="py-1.5 pr-2 text-right font-mono text-[10px] text-base-content/55">
										{fmtAge(entry.latest.measuredAt)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</div>
		{/each}
	</div>
{/if}
