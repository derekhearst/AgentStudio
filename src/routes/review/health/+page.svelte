<svelte:head><title>Platform Health | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { getOperationalSnapshotQuery } from '$lib/observability/review.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import Sparkline from '$lib/ui/Sparkline.svelte';

	type Result = Awaited<ReturnType<typeof getOperationalSnapshotQuery>>;
	type Entry = Extract<Result, { adminOnly: false }>['entries'][number];

	let result = $state<Result | null>(null);
	let loading = $state(false);

	onMount(() => void load());

	async function load() {
		loading = true;
		try {
			result = await getOperationalSnapshotQuery();
		} finally {
			loading = false;
		}
	}

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

	function groupedEntries(entries: Entry[]): Array<{ group: string; rows: Entry[] }> {
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
				})
			}));
	}

	function statusTone(status: string): string {
		switch (status) {
			case 'open':
				return 'badge-warning';
			case 'in_progress':
				return 'badge-info';
			case 'resolved':
				return 'badge-success';
			case 'dismissed':
				return 'badge-neutral';
			default:
				return 'badge-ghost';
		}
	}

	function sparklineTone(metric: string): { stroke: string; fill: string } {
		// jobs.duration_ms / runs.duration_ms — info tone (latency is a gauge, not strictly bad)
		if (metric.endsWith('.duration_ms')) return { stroke: 'stroke-info text-info', fill: 'fill-info/10' };
		// queue.depth.failed_recent + jobs.lifecycle.failed + runs.lifecycle.failed — error tone
		if (metric.includes('failed')) return { stroke: 'stroke-error text-error', fill: 'fill-error/10' };
		// review_inbox.open — warning tone (more open items = more attention needed)
		if (metric.startsWith('review_inbox')) return { stroke: 'stroke-warning text-warning', fill: 'fill-warning/10' };
		// jobs.lifecycle.completed + runs.lifecycle.completed — success tone
		if (metric.includes('completed')) return { stroke: 'stroke-success text-success', fill: 'fill-success/10' };
		// queue.depth.* (pending, leased, running, retry_wait) — primary
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
		// Counters + depth: integer-ish display.
		return Math.round(num).toString();
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Platform Health</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Last 24 hours of operational metrics with per-row sparklines + review-inbox rollup.
						Sampled every 5 minutes plus events from job + run finishes. Admin only.
					</p>
				</div>
				<div class="flex items-center gap-2">
					<a class="btn btn-ghost btn-xs" href="/review">← Inbox</a>
					<button class="btn btn-ghost btn-xs" type="button" onclick={() => void load()} disabled={loading}>
						{loading ? 'Loading…' : 'Refresh'}
					</button>
				</div>
			</div>
		{/snippet}
	</ContentPanel>

	{#if !result}
		<div class="flex justify-center py-20">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if result.adminOnly}
		<div class="alert alert-warning alert-soft border-warning/40 p-6 text-center">
			<p class="text-sm font-medium">Admin only</p>
			<p class="mt-1 text-xs opacity-70">
				Platform Health is visible only to users with the <code>admin</code> role.
			</p>
		</div>
	{:else}
		{#if result.rollup.length > 0}
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Review inbox — last 24h</h2>
				{/snippet}
				<div class="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
					{#each result.rollup as row (row.type + row.status)}
						<div class="rounded-xl border border-base-300/60 bg-base-100 p-2.5">
							<div class="flex items-center gap-1.5">
								<span class="text-xs font-mono">{row.type}</span>
								<span class="badge badge-xs {statusTone(row.status)}">{row.status}</span>
							</div>
							<p class="mt-1 text-2xl font-bold leading-tight">{row.count}</p>
						</div>
					{/each}
				</div>
			</ContentPanel>
		{/if}

		{#if result.entries.length === 0}
			<div class="card card-body bg-base-200/30 border-base-300/60 rounded-2xl border p-12 text-center text-sm text-base-content/55">
				No metric samples yet. The 5-minute sampler runs after the first scheduled tick — wait
				up to ~5 minutes for the first row, or trigger an enqueue manually via
				<code>metrics_sample</code> in the jobs admin.
			</div>
		{:else}
			{#each groupedEntries(result.entries) as group (group.group)}
				<ContentPanel>
					{#snippet header()}
						<div class="flex flex-1 items-center justify-between gap-2">
							<h2 class="font-mono text-sm font-semibold">{group.group}</h2>
							<span class="badge badge-sm badge-ghost">{group.rows.length}</span>
						</div>
					{/snippet}
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
				</ContentPanel>
			{/each}
		{/if}
	{/if}
</div>
