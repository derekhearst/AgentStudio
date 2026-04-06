<svelte:head><title>Cost Dashboard | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { getCostSummary, getBudgetStatus } from '$lib/cost';
	import { getSettings } from '$lib/settings';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type CostData = Awaited<ReturnType<typeof getCostSummary>>;
	type BudgetData = Awaited<ReturnType<typeof getBudgetStatus>>;

	let costData = $state<CostData | null>(null);
	let budgetData = $state<BudgetData | null>(null);
	let period = $state<'day' | 'week' | 'month'>('month');
	let budgetConfig = $state<{ dailyLimit: number | null; monthlyLimit: number | null }>({
		dailyLimit: null,
		monthlyLimit: null
	});

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		const [cost, budget, settings] = await Promise.all([
			getCostSummary({ period }),
			getBudgetStatus(),
			getSettings()
		]);
		costData = cost;
		budgetData = budget;
		if (settings?.budgetConfig) {
			budgetConfig = settings.budgetConfig;
		}
	}

	async function changePeriod(p: 'day' | 'week' | 'month') {
		period = p;
		costData = null;
		const cost = await getCostSummary({ period: p });
		costData = cost;
	}

	function fmt(val: string | number): string {
		const n = Number(val);
		if (n === 0) return '$0.00';
		if (n >= 0.01) return `$${n.toFixed(2)}`;
		if (n >= 0.0001) return `$${n.toFixed(4)}`;
		if (n >= 0.000001) return `$${n.toFixed(6)}`;
		return `$${n.toFixed(8)}`;
	}

	function pct(spent: string, limit: number | null): number | null {
		if (!limit) return null;
		return Math.min(100, (Number(spent) / limit) * 100);
	}

	const sourceLabels: Record<string, string> = {
		chat: 'Chat',
		agent_planner: 'Agent Planner',
		agent_synthesis: 'Agent Synthesis',
		titlegen: 'Title Generation',
		memory_extract: 'Memory Extraction',
		image_gen: 'Image Generation',
	};

	function sourceLabel(source: string): string {
		return sourceLabels[source] ?? source;
	}
</script>

<section class="space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div>
				<h1 class="text-3xl font-bold">Cost Dashboard</h1>
				<p class="text-sm text-base-content/70">Track all LLM spending by source, model, and time period.</p>
			</div>
		{/snippet}
		{#snippet actions()}
			<div class="join">
				<button class="btn join-item" class:btn-active={period === 'day'} type="button" onclick={() => changePeriod('day')}>Day</button>
				<button class="btn join-item" class:btn-active={period === 'week'} type="button" onclick={() => changePeriod('week')}>Week</button>
				<button class="btn join-item" class:btn-active={period === 'month'} type="button" onclick={() => changePeriod('month')}>Month</button>
			</div>
		{/snippet}
	</ContentPanel>

	{#if !costData}
		<div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>
	{:else}
		<!-- Budget Alerts -->
		{#if budgetData}
			<div class="grid gap-3 sm:grid-cols-2">
				<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
					<h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/55">Daily Spend</h3>
					<p class="mt-1 text-2xl font-bold">{fmt(budgetData.dailySpend)}</p>
					{#if budgetConfig.dailyLimit}
						{@const p = pct(budgetData.dailySpend, budgetConfig.dailyLimit)}
						<p class="mt-1 text-xs text-base-content/70">of {fmt(budgetConfig.dailyLimit)} limit</p>
						<progress
							class="progress mt-2 w-full"
							class:progress-warning={p !== null && p >= 80 && p < 100}
							class:progress-error={p !== null && p >= 100}
							class:progress-success={p !== null && p < 80}
							value={p}
							max="100"
						></progress>
					{/if}
				</div>
				<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
					<h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/55">Monthly Spend</h3>
					<p class="mt-1 text-2xl font-bold">{fmt(budgetData.monthlySpend)}</p>
					{#if budgetConfig.monthlyLimit}
						{@const p = pct(budgetData.monthlySpend, budgetConfig.monthlyLimit)}
						<p class="mt-1 text-xs text-base-content/70">of {fmt(budgetConfig.monthlyLimit)} limit</p>
						<progress
							class="progress mt-2 w-full"
							class:progress-warning={p !== null && p >= 80 && p < 100}
							class:progress-error={p !== null && p >= 100}
							class:progress-success={p !== null && p < 80}
							value={p}
							max="100"
						></progress>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Summary Cards -->
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/55">Total Spend</h3>
				<p class="mt-1 text-2xl font-bold">{fmt(costData.totalSpend)}</p>
				<p class="text-xs text-base-content/70">{costData.callCount} LLM calls</p>
			</div>
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/55">Agent Spend</h3>
				<p class="mt-1 text-2xl font-bold">{fmt(costData.agentSpend)}</p>
				<p class="text-xs text-base-content/70">{costData.agentRunCount} runs</p>
			</div>
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/55">Tokens In</h3>
				<p class="mt-1 text-2xl font-bold">{costData.totalTokensIn.toLocaleString()}</p>
			</div>
			<div class="rounded-2xl border border-base-300 bg-base-100 p-4">
				<h3 class="text-sm font-semibold uppercase tracking-wide text-base-content/55">Tokens Out</h3>
				<p class="mt-1 text-2xl font-bold">{costData.totalTokensOut.toLocaleString()}</p>
			</div>
		</div>

		<!-- Spend by Source -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Spend by Source</h2>{/snippet}
			{#if costData.bySource.length === 0}
				<p class="mt-2 text-sm text-base-content/70">No usage in this period.</p>
			{:else}
				<div class="mt-3 overflow-x-auto">
					<table class="table table-sm">
						<thead>
							<tr>
								<th>Source</th>
								<th class="text-right">Cost</th>
								<th class="text-right">Tokens In</th>
								<th class="text-right">Tokens Out</th>
								<th class="text-right">Calls</th>
							</tr>
						</thead>
						<tbody>
							{#each costData.bySource as row (row.source)}
								<tr>
									<td>
										<span class="badge badge-sm badge-ghost">{sourceLabel(row.source)}</span>
									</td>
									<td class="text-right">{fmt(row.cost)}</td>
									<td class="text-right">{row.tokensIn.toLocaleString()}</td>
									<td class="text-right">{row.tokensOut.toLocaleString()}</td>
									<td class="text-right">{row.count}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</ContentPanel>

		<!-- Cost by Model -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Spend by Model</h2>{/snippet}
			{#if costData.byModel.length === 0}
				<p class="mt-2 text-sm text-base-content/70">No model usage in this period.</p>
			{:else}
				<div class="mt-3 overflow-x-auto">
					<table class="table table-sm">
						<thead>
							<tr>
								<th>Model</th>
								<th class="text-right">Cost</th>
								<th class="text-right">Tokens In</th>
								<th class="text-right">Tokens Out</th>
								<th class="text-right">Calls</th>
							</tr>
						</thead>
						<tbody>
							{#each costData.byModel as row (row.model)}
								<tr>
									<td class="font-mono text-xs">{row.model ?? 'unknown'}</td>
									<td class="text-right">{fmt(row.cost)}</td>
									<td class="text-right">{row.tokensIn.toLocaleString()}</td>
									<td class="text-right">{row.tokensOut.toLocaleString()}</td>
									<td class="text-right">{row.count}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</ContentPanel>

		<!-- Daily Breakdown -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Daily Breakdown</h2>{/snippet}
			{#if costData.dailyBreakdown.length === 0}
				<p class="mt-2 text-sm text-base-content/70">No usage data.</p>
			{:else}
				<div class="mt-3 space-y-1">
					{#each costData.dailyBreakdown as day (day.date)}
						{@const maxCost = Math.max(...costData.dailyBreakdown.map((d) => Number(d.cost)), 0.001)}
						<div class="flex items-center gap-3 text-sm">
							<span class="w-24 shrink-0 font-mono text-xs">{day.date}</span>
							<div class="flex-1">
								<div
									class="h-4 rounded bg-primary"
									style="width: {Math.max(2, (Number(day.cost) / maxCost) * 100)}%"
								></div>
							</div>
							<span class="w-20 shrink-0 text-right font-mono text-xs">{fmt(day.cost)}</span>
							<span class="w-12 shrink-0 text-right text-xs text-base-content/70">{day.count}</span>
						</div>
					{/each}
				</div>
			{/if}
		</ContentPanel>

		<!-- Top Conversations -->
		<ContentPanel>
			{#snippet header()}<h2 class="font-semibold">Top Conversations by Cost</h2>{/snippet}
			{#if costData.topConversations.length === 0}
				<p class="mt-2 text-sm text-base-content/70">No conversations in this period.</p>
			{:else}
				<div class="mt-3 space-y-2">
					{#each costData.topConversations as convo (convo.id)}
						<a href="/chat/{convo.id}" class="flex items-center justify-between rounded-xl border border-base-300 p-3 text-sm hover:bg-base-200/50">
							<div>
								<p class="font-medium">{convo.title}</p>
								<p class="text-xs text-base-content/70">{convo.model}</p>
							</div>
							<span class="font-mono">{fmt(convo.totalCost)}</span>
						</a>
					{/each}
				</div>
			{/if}
		</ContentPanel>
	{/if}
</section>

