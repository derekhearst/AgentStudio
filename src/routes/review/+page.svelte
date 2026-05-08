<svelte:head><title>Review | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listReviewItemsQuery,
		listRecentFailuresQuery,
		getOperationalSnapshotQuery,
	} from '$lib/observability/review.remote';
	import { getCostSummary, getBudgetStatus } from '$lib/costs/cost.remote';
	import { listAppLogsQuery, countLogsBySourceQuery } from '$lib/observability/logs.remote';
	import { getSettings } from '$lib/settings';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import KpiStrip from './_components/KpiStrip.svelte';
	import RecentFailures from './_components/RecentFailures.svelte';
	import LogsPanel from './_components/LogsPanel.svelte';
	import InboxList from './_components/InboxList.svelte';
	import CostDetails from './_components/CostDetails.svelte';
	import HealthDetails from './_components/HealthDetails.svelte';

	type Inbox = Awaited<ReturnType<typeof listReviewItemsQuery>>;
	type Cost = Awaited<ReturnType<typeof getCostSummary>>;
	type Budget = Awaited<ReturnType<typeof getBudgetStatus>>;
	type Snapshot = Awaited<ReturnType<typeof getOperationalSnapshotQuery>>;
	type Logs = Awaited<ReturnType<typeof listAppLogsQuery>>;
	type LogSources = Awaited<ReturnType<typeof countLogsBySourceQuery>>;
	type Failures = Awaited<ReturnType<typeof listRecentFailuresQuery>>;

	let period = $state<'day' | 'week' | 'month'>('day');
	let typeFilter = $state<string>('');
	let statusFilter = $state<string>('open');
	let severityFilter = $state<string>('');

	let logLevel = $state<'debug' | 'info' | 'warn' | 'error'>('warn');
	let logSource = $state<string>('');
	let logSearch = $state<string>('');
	let logLimit = $state<number>(100);

	let expanded = $state<Record<string, boolean>>({
		failures: true,
		logs: true,
		cost: false,
		health: false,
	});

	let inbox = $state<Inbox | null>(null);
	let cost = $state<Cost | null>(null);
	let budget = $state<Budget | null>(null);
	let snapshot = $state<Snapshot | null>(null);
	let logs = $state<Logs | null>(null);
	let logSources = $state<LogSources | null>(null);
	let failures = $state<Failures | null>(null);
	let budgetConfig = $state<{ dailyLimit: number | null; monthlyLimit: number | null }>({
		dailyLimit: null,
		monthlyLimit: null,
	});

	let loading = $state(false);
	let logsLoading = $state(false);

	const adminOnly = $derived(
		(inbox?.adminOnly === true) ||
			(snapshot?.adminOnly === true) ||
			(failures?.adminOnly === true),
	);

	const warnErrorCount24h = $derived.by(() => {
		if (!logSources) return 0;
		// Total of warn+error rows across all sources in last 24h. The countLogsBySourceQuery
		// counts everything in the window, so we approximate by relying on the logs we have
		// loaded plus the inbox-rollup tone — use the focused logs result.
		if (!logs) return 0;
		return logs.logs.filter((l) => l.level === 'warn' || l.level === 'error').length;
	});

	const topNoisySource = $derived.by(() => {
		if (!logSources || logSources.counts.length === 0) return null;
		const top = logSources.counts[0];
		return top?.source ?? null;
	});

	onMount(() => void loadAll());

	async function loadAll() {
		loading = true;
		try {
			const [inboxRes, costRes, snapshotRes, logsRes, logSourcesRes, failuresRes, budgetRes, settingsRes] =
				await Promise.all([
					listReviewItemsQuery(buildInboxArgs()),
					getCostSummary({ period }),
					getOperationalSnapshotQuery(),
					listAppLogsQuery(buildLogsArgs()),
					countLogsBySourceQuery({ windowMinutes: 60 * 24 }),
					listRecentFailuresQuery({ hours: 24, limit: 20 }),
					getBudgetStatus(),
					getSettings(),
				]);
			inbox = inboxRes;
			cost = costRes;
			snapshot = snapshotRes;
			logs = logsRes;
			logSources = logSourcesRes;
			failures = failuresRes;
			budget = budgetRes;
			if (settingsRes?.budgetConfig) {
				budgetConfig = {
					dailyLimit: settingsRes.budgetConfig.dailyLimit ?? null,
					monthlyLimit: settingsRes.budgetConfig.monthlyLimit ?? null,
				};
			}
		} finally {
			loading = false;
		}
	}

	function buildInboxArgs() {
		return {
			type: typeFilter ? (typeFilter as 'approval_request') : undefined,
			status: statusFilter ? (statusFilter as 'open') : undefined,
			severity: severityFilter ? (severityFilter as 'info' | 'warning' | 'critical') : undefined,
			openOnly: !statusFilter,
		};
	}

	function buildLogsArgs() {
		return {
			minLevel: logLevel,
			source: logSource || undefined,
			search: logSearch.trim() || undefined,
			limit: logLimit,
		};
	}

	async function reloadCost() {
		cost = await getCostSummary({ period });
	}

	async function reloadInbox() {
		inbox = await listReviewItemsQuery(buildInboxArgs());
	}

	async function reloadLogs() {
		logsLoading = true;
		try {
			logs = await listAppLogsQuery(buildLogsArgs());
		} finally {
			logsLoading = false;
		}
	}

	function toggle(section: 'failures' | 'logs' | 'cost' | 'health') {
		expanded[section] = !expanded[section];
	}

	async function changePeriod(p: 'day' | 'week' | 'month') {
		period = p;
		await reloadCost();
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="Review" subtitle="Cost, errors, logs, and human-review queue (admin only)">
		{#snippet actions()}
			<div class="join">
				<button class="btn btn-xs join-item" class:btn-active={period === 'day'} type="button" onclick={() => changePeriod('day')}>Today</button>
				<button class="btn btn-xs join-item" class:btn-active={period === 'week'} type="button" onclick={() => changePeriod('week')}>Week</button>
				<button class="btn btn-xs join-item" class:btn-active={period === 'month'} type="button" onclick={() => changePeriod('month')}>Month</button>
			</div>
			<button class="btn btn-ghost btn-xs" type="button" onclick={() => void loadAll()} disabled={loading}>
				{loading ? 'Loading…' : 'Refresh'}
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-3 sm:space-y-4">

	{#if !inbox}
		<div class="flex justify-center py-20">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if adminOnly}
		<div class="alert alert-warning alert-soft border-warning/40 p-6 text-center">
			<p class="text-sm font-medium">Admin only</p>
			<p class="mt-1 text-xs opacity-70">
				The Review dashboard is visible only to users with the <code>admin</code> role.
			</p>
		</div>
	{:else}
		<!-- KPI strip -->
		<KpiStrip
			cost={cost}
			budget={budget}
			snapshot={snapshot}
			inbox={inbox}
			warnErrorCount24h={warnErrorCount24h}
			topNoisySource={topNoisySource}
			period={period}
		/>

		<!-- Recent failures -->
		<ContentPanel>
			{#snippet header()}
				<button type="button" class="flex flex-1 items-center justify-between gap-2" onclick={() => toggle('failures')}>
					<div class="flex items-center gap-2">
						<h2 class="font-semibold">Recent failures</h2>
						{#if failures && !failures.adminOnly}
							<span class="badge badge-sm" class:badge-error={failures.failures.length > 0} class:badge-ghost={failures.failures.length === 0}>
								{failures.failures.length}
							</span>
						{/if}
					</div>
					<svg class="size-3 transition-transform {expanded.failures ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="3 5 6 8 9 5" />
					</svg>
				</button>
			{/snippet}
			{#if expanded.failures}
				{#if failures && !failures.adminOnly}
					<RecentFailures failures={failures.failures} />
				{/if}
			{/if}
		</ContentPanel>

		<!-- Logs -->
		<ContentPanel>
			{#snippet header()}
				<button type="button" class="flex flex-1 items-center justify-between gap-2" onclick={() => toggle('logs')}>
					<div class="flex items-center gap-2">
						<h2 class="font-semibold">Logs</h2>
						<span class="badge badge-sm badge-ghost">{logs?.logs.length ?? 0}</span>
						<span class="badge badge-sm" class:badge-error={logLevel === 'error'} class:badge-warning={logLevel === 'warn'} class:badge-info={logLevel === 'info'} class:badge-ghost={logLevel === 'debug'}>≥ {logLevel}</span>
					</div>
					<svg class="size-3 transition-transform {expanded.logs ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="3 5 6 8 9 5" />
					</svg>
				</button>
			{/snippet}
			{#if expanded.logs}
				{#if logs && logSources}
					<LogsPanel
						logs={logs.logs}
						sources={logSources.counts}
						bind:level={logLevel}
						bind:source={logSource}
						bind:search={logSearch}
						bind:limit={logLimit}
						loading={logsLoading}
						onChange={() => void reloadLogs()}
					/>
				{/if}
			{/if}
		</ContentPanel>

		<!-- Inbox -->
		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 items-center justify-between gap-2">
					<h2 class="font-semibold">Inbox</h2>
					<span class="badge badge-sm badge-ghost">{inbox.items.length}</span>
				</div>
			{/snippet}
			<InboxList
				inbox={inbox}
				bind:typeFilter
				bind:statusFilter
				bind:severityFilter
				onChange={() => void reloadInbox()}
			/>
		</ContentPanel>

		<!-- Cost details -->
		<ContentPanel>
			{#snippet header()}
				<button type="button" class="flex flex-1 items-center justify-between gap-2" onclick={() => toggle('cost')}>
					<div class="flex items-center gap-2">
						<h2 class="font-semibold">Cost details</h2>
						<span class="badge badge-sm badge-ghost">{period}</span>
					</div>
					<svg class="size-3 transition-transform {expanded.cost ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="3 5 6 8 9 5" />
					</svg>
				</button>
			{/snippet}
			{#if expanded.cost}
				{#if cost}
					<CostDetails cost={cost} budget={budget} budgetConfig={budgetConfig} />
				{/if}
			{/if}
		</ContentPanel>

		<!-- Platform health -->
		<ContentPanel>
			{#snippet header()}
				<button type="button" class="flex flex-1 items-center justify-between gap-2" onclick={() => toggle('health')}>
					<div class="flex items-center gap-2">
						<h2 class="font-semibold">Platform health</h2>
						{#if snapshot && !snapshot.adminOnly}
							<span class="badge badge-sm badge-ghost">{snapshot.entries.length}</span>
						{/if}
					</div>
					<svg class="size-3 transition-transform {expanded.health ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
						<polyline points="3 5 6 8 9 5" />
					</svg>
				</button>
			{/snippet}
			{#if expanded.health}
				{#if snapshot && !snapshot.adminOnly}
					<HealthDetails entries={snapshot.entries} />
				{/if}
			{/if}
		</ContentPanel>
	{/if}
	</div>
</div>
