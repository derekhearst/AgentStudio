<script lang="ts">
	import Sparkline from '$lib/ui/Sparkline.svelte';
	import type { getCostSummary, getBudgetStatus } from '$lib/costs/cost.remote';
	import type { getOperationalSnapshotQuery, listReviewItemsQuery } from '$lib/observability/review.remote';

	type Cost = Awaited<ReturnType<typeof getCostSummary>>;
	type Budget = Awaited<ReturnType<typeof getBudgetStatus>>;
	type Snapshot = Awaited<ReturnType<typeof getOperationalSnapshotQuery>>;
	type Inbox = Awaited<ReturnType<typeof listReviewItemsQuery>>;

	let {
		cost,
		budget,
		snapshot,
		inbox,
		warnErrorCount24h,
		topNoisySource,
		period,
	}: {
		cost: Cost | null;
		budget: Budget | null;
		snapshot: Snapshot | null;
		inbox: Inbox | null;
		warnErrorCount24h: number;
		topNoisySource: string | null;
		period: 'day' | 'week' | 'month';
	} = $props();

	function fmtMoney(val: string | number): string {
		const n = Number(val);
		if (n === 0) return '$0.00';
		if (n >= 0.01) return `$${n.toFixed(2)}`;
		if (n >= 0.0001) return `$${n.toFixed(4)}`;
		return `$${n.toFixed(6)}`;
	}

	const periodLabel = $derived(period === 'day' ? 'today' : period);

	const costSeries = $derived.by(() => {
		if (!cost?.dailyBreakdown) return [];
		return cost.dailyBreakdown.map((d) => ({ value: Number(d.cost), measuredAt: d.date }));
	});

	const failedRunsEntry = $derived.by(() => {
		if (!snapshot || snapshot.adminOnly) return null;
		return snapshot.entries.find((e) => e.metric === 'runs.failed_24h') ?? null;
	});

	const failedRunsCount = $derived(failedRunsEntry ? Math.round(Number(failedRunsEntry.latest.value)) : 0);

	const inboxCounts = $derived.by(() => {
		if (!inbox || inbox.adminOnly) return { open: 0, critical: 0, warning: 0 };
		// Inbox rollup is grouped by (type, status, severity) — sum open items by severity.
		// Severity isn't on the rollup row so derive from items array (which is already
		// filtered to the active query — fall back to 0 if not "open" filter).
		const openItems = inbox.items.filter((i) => i.status === 'open' || i.status === 'in_progress');
		const critical = openItems.filter((i) => i.severity === 'critical').length;
		const warning = openItems.filter((i) => i.severity === 'warning').length;
		return { open: openItems.length, critical, warning };
	});

	const topModel = $derived(cost?.byModel?.[0]?.model ?? null);
</script>

<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
	<!-- Cost -->
	<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
		<div class="flex items-center justify-between">
			<p class="text-[10px] uppercase tracking-wide text-base-content/55">Cost ({periodLabel})</p>
			<span class="badge badge-xs badge-ghost">{cost?.callCount ?? 0} calls</span>
		</div>
		<p class="mt-1 text-2xl font-bold leading-tight">
			{cost ? fmtMoney(cost.totalSpend) : '—'}
		</p>
		{#if costSeries.length > 1}
			<div class="mt-1">
				<Sparkline points={costSeries} strokeClass="stroke-primary text-primary" fillClass="fill-primary/10" width={140} height={20} />
			</div>
		{/if}
		{#if topModel}
			<p class="mt-1 truncate font-mono text-[10px] text-base-content/55">top: {topModel}</p>
		{/if}
	</div>

	<!-- Failed runs 24h -->
	<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
		<div class="flex items-center justify-between">
			<p class="text-[10px] uppercase tracking-wide text-base-content/55">Failed runs · 24h</p>
		</div>
		<p
			class="mt-1 text-2xl font-bold leading-tight"
			class:text-error={failedRunsCount > 0}
		>
			{failedRunsCount}
		</p>
		{#if failedRunsEntry && failedRunsEntry.series.length > 1}
			<div class="mt-1">
				<Sparkline
					points={failedRunsEntry.series}
					strokeClass={failedRunsCount > 0 ? 'stroke-error text-error' : 'stroke-base-content/40 text-base-content/40'}
					fillClass={failedRunsCount > 0 ? 'fill-error/10' : 'fill-base-content/5'}
					width={140}
					height={20}
				/>
			</div>
		{/if}
	</div>

	<!-- Warn + Error logs 24h -->
	<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
		<div class="flex items-center justify-between">
			<p class="text-[10px] uppercase tracking-wide text-base-content/55">Warn + Error logs · 24h</p>
		</div>
		<p
			class="mt-1 text-2xl font-bold leading-tight"
			class:text-warning={warnErrorCount24h > 0}
		>
			{warnErrorCount24h}
		</p>
		{#if topNoisySource}
			<p class="mt-1 truncate font-mono text-[10px] text-base-content/55">top: {topNoisySource}</p>
		{/if}
	</div>

	<!-- Open review items -->
	<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
		<div class="flex items-center justify-between">
			<p class="text-[10px] uppercase tracking-wide text-base-content/55">Open review items</p>
		</div>
		<p
			class="mt-1 text-2xl font-bold leading-tight"
			class:text-warning={inboxCounts.open > 0}
		>
			{inboxCounts.open}
		</p>
		{#if inboxCounts.critical > 0 || inboxCounts.warning > 0}
			<p class="mt-1 text-[10px] text-base-content/55">
				{inboxCounts.critical} critical · {inboxCounts.warning} warning
			</p>
		{/if}
	</div>

	{#if budget}
		<!-- Budget cards span the same row when present -->
		<div class="rounded-xl border border-base-300/60 bg-base-100 p-3 sm:col-span-2">
			<p class="text-[10px] uppercase tracking-wide text-base-content/55">Daily spend</p>
			<p class="mt-1 text-xl font-bold leading-tight">{fmtMoney(budget.dailySpend)}</p>
		</div>
		<div class="rounded-xl border border-base-300/60 bg-base-100 p-3 sm:col-span-2">
			<p class="text-[10px] uppercase tracking-wide text-base-content/55">Monthly spend</p>
			<p class="mt-1 text-xl font-bold leading-tight">{fmtMoney(budget.monthlySpend)}</p>
		</div>
	{/if}
</div>
