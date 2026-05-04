<svelte:head><title>Platform Health | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { getOperationalSnapshotQuery } from '$lib/observability/review.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Result = Awaited<ReturnType<typeof getOperationalSnapshotQuery>>;

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

	type MetricRow = {
		id: string;
		metric: string;
		dimension: Record<string, unknown>;
		value: string | number;
		measuredAt: Date | string;
	};

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

	function groupedMetrics(metrics: MetricRow[]): Array<{ group: string; rows: MetricRow[] }> {
		const map = new Map<string, MetricRow[]>();
		for (const row of metrics) {
			const g = metricGroup(row.metric);
			const list = map.get(g) ?? [];
			list.push(row);
			map.set(g, list);
		}
		return [...map.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([group, rows]) => ({
				group,
				rows: rows.sort((a, b) => a.metric.localeCompare(b.metric)),
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
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Platform Health</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Most-recent operational metrics + 24h review-inbox rollup. Sampled every 5
						minutes. Admin only.
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
		<div class="rounded-2xl border border-warning/40 bg-warning/10 p-6 text-center">
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

		{#if result.metrics.length === 0}
			<div class="rounded-2xl border border-base-300/60 bg-base-200/30 p-12 text-center text-sm text-base-content/55">
				No metric samples yet. The 5-minute sampler runs after the first scheduled tick — wait
				up to ~5 minutes for the first row, or trigger an enqueue manually via
				<code>metrics_sample</code> in the jobs admin.
			</div>
		{:else}
			{#each groupedMetrics(result.metrics) as group (group.group)}
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
								<th class="py-1 pr-2 text-right">Value</th>
								<th class="py-1 pr-2 text-right">Measured</th>
							</tr>
						</thead>
						<tbody>
							{#each group.rows as row (row.id)}
								<tr class="border-t border-base-300/40">
									<td class="py-1.5 pr-2 font-mono">{row.metric}</td>
									<td class="py-1.5 pr-2 font-mono text-[10px] text-base-content/70">
										{dimensionString(row.dimension)}
									</td>
									<td class="py-1.5 pr-2 text-right font-mono font-semibold">{row.value}</td>
									<td class="py-1.5 pr-2 text-right font-mono text-[10px] text-base-content/55">
										{fmtAge(row.measuredAt)}
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
