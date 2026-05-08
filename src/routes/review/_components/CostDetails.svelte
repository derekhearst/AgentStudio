<script lang="ts">
	import type { getCostSummary, getBudgetStatus } from '$lib/costs/cost.remote';

	type Cost = Awaited<ReturnType<typeof getCostSummary>>;
	type Budget = Awaited<ReturnType<typeof getBudgetStatus>>;

	let {
		cost,
		budget,
		budgetConfig,
	}: {
		cost: Cost;
		budget: Budget | null;
		budgetConfig: { dailyLimit: number | null; monthlyLimit: number | null };
	} = $props();

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
		image_gen: 'Image Generation',
	};

	function sourceLabel(src: string): string {
		return sourceLabels[src] ?? src;
	}
</script>

<div class="space-y-3 sm:space-y-4">
	<!-- Budget cards -->
	{#if budget}
		<div class="grid gap-3 sm:grid-cols-2">
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<h3 class="text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Daily spend</h3>
				<p class="mt-1 text-2xl font-bold">{fmt(budget.dailySpend)}</p>
				{#if budgetConfig.dailyLimit}
					{@const p = pct(budget.dailySpend, budgetConfig.dailyLimit)}
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
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<h3 class="text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Monthly spend</h3>
				<p class="mt-1 text-2xl font-bold">{fmt(budget.monthlySpend)}</p>
				{#if budgetConfig.monthlyLimit}
					{@const p = pct(budget.monthlySpend, budgetConfig.monthlyLimit)}
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

	<!-- Summary cards -->
	<div class="grid gap-3 sm:grid-cols-3">
		<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
			<h3 class="text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Total Spend</h3>
			<p class="mt-1 text-2xl font-bold">{fmt(cost.totalSpend)}</p>
			<p class="text-xs text-base-content/70">{cost.callCount} LLM calls</p>
		</div>
		<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
			<h3 class="text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Tokens In</h3>
			<p class="mt-1 text-2xl font-bold">{cost.totalTokensIn.toLocaleString()}</p>
		</div>
		<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
			<h3 class="text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Tokens Out</h3>
			<p class="mt-1 text-2xl font-bold">{cost.totalTokensOut.toLocaleString()}</p>
		</div>
	</div>

	<!-- Combined LLM + Tool spend -->
	<div>
		<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">LLM + Tool spend (combined)</p>
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Total</p>
				<p class="mt-1 text-xl font-bold">{fmt(cost.combinedSpend)}</p>
			</div>
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">LLM</p>
				<p class="mt-1 text-xl font-bold">{fmt(cost.totalSpend)}</p>
			</div>
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Tools</p>
				<p class="mt-1 text-xl font-bold">{fmt(cost.toolSpend)}</p>
			</div>
			<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
				<p class="text-[10px] uppercase tracking-wide text-base-content/55">Tool calls</p>
				<p class="mt-1 text-xl font-bold">{cost.toolCallCount}</p>
			</div>
		</div>
	</div>

	<!-- Daily breakdown bar chart -->
	{#if cost.dailyBreakdown.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Daily breakdown</p>
			<div class="space-y-1">
				{#each cost.dailyBreakdown as day (day.date)}
					{@const maxCost = Math.max(...cost.dailyBreakdown.map((d) => Number(d.cost)), 0.001)}
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
		</div>
	{/if}

	<!-- Spend by Source -->
	{#if cost.bySource.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Spend by source</p>
			<div class="overflow-x-auto rounded-xl border border-base-300/60">
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
						{#each cost.bySource as row (row.source)}
							<tr>
								<td><span class="badge badge-sm badge-ghost">{sourceLabel(row.source)}</span></td>
								<td class="text-right">{fmt(row.cost)}</td>
								<td class="text-right">{row.tokensIn.toLocaleString()}</td>
								<td class="text-right">{row.tokensOut.toLocaleString()}</td>
								<td class="text-right">{row.count}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	<!-- Spend by Model -->
	{#if cost.byModel.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Spend by model</p>
			<div class="overflow-x-auto rounded-xl border border-base-300/60">
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
						{#each cost.byModel as row (row.model)}
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
		</div>
	{/if}

	<!-- Top Conversations -->
	{#if cost.topConversations.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Top conversations by cost</p>
			<div class="space-y-1.5">
				{#each cost.topConversations as convo (convo.id)}
					<a href="/chat/{convo.id}" class="flex items-center justify-between rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 text-sm hover:bg-base-200/40">
						<div class="min-w-0 flex-1">
							<p class="line-clamp-1 font-medium">{convo.title}</p>
							<p class="text-xs text-base-content/70">{convo.model}</p>
						</div>
						<span class="font-mono">{fmt(convo.totalCost)}</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Top Runs -->
	{#if cost.byRun.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Top runs by cost</p>
			<div class="space-y-1.5">
				{#each cost.byRun as row (row.runId)}
					<a
						href={row.runId ? `/review/trace/${row.runId}` : '#'}
						class="flex items-center justify-between rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 text-sm hover:bg-base-200/40"
					>
						<div class="min-w-0 flex-1">
							<p class="line-clamp-1 font-medium">{row.label ?? row.runId?.slice(0, 8)}</p>
							<p class="text-xs text-base-content/60">{row.source} · {row.state} · {row.tokensIn + row.tokensOut} tokens</p>
						</div>
						<span class="font-mono">{fmt(row.cost)}</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Top Agents -->
	{#if cost.byAgent.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Top agents by cost</p>
			<div class="space-y-1.5">
				{#each cost.byAgent as row (row.agentId)}
					<a href="/agents/{row.agentId}" class="flex items-center justify-between rounded-xl border border-base-300/60 bg-base-100 px-3 py-2 text-sm hover:bg-base-200/40">
						<div class="min-w-0 flex-1">
							<p class="line-clamp-1 font-medium">{row.name ?? row.agentId?.slice(0, 8)}</p>
							<p class="text-xs text-base-content/60">{row.role ?? ''} · {row.count} calls</p>
						</div>
						<span class="font-mono">{fmt(row.cost)}</span>
					</a>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Tool Spend -->
	{#if cost.byTool.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Tool spend</p>
			<div class="overflow-x-auto rounded-xl border border-base-300/60">
				<table class="table table-zebra table-sm">
					<thead>
						<tr>
							<th>Tool</th>
							<th>Provider</th>
							<th class="text-right">Units</th>
							<th class="text-right">Calls</th>
							<th class="text-right">Cost</th>
						</tr>
					</thead>
					<tbody>
						{#each cost.byTool as row (row.toolName + (row.provider ?? '') + row.unitType)}
							<tr>
								<td class="font-medium">{row.toolName}</td>
								<td class="text-xs text-base-content/70">{row.provider ?? '—'}</td>
								<td class="text-right font-mono text-sm">{row.units} {row.unitType}</td>
								<td class="text-right font-mono text-sm">{row.count}</td>
								<td class="text-right font-mono text-sm">{fmt(row.cost)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
