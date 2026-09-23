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
	import { remoteErrorMessage } from '$lib/ui/remote-error';
	import type { ReviewItemType } from '$lib/observability/observability.schema';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { fetchFresh } from '$lib/ui/fresh-query';
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
	// Why the last inbox reload failed. Shown over the list, which still holds the previous
	// filter's items — without this they sat there under the new filter's label.
	let inboxError = $state<string | null>(null);
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

	/*
	 * One entry per section, so each load clears only its own failure. A single shared
	 * message meant a logs-filter change that failed stayed on screen after the next one
	 * worked, and replaced whatever Refresh had said about the other sections.
	 */
	const SECTIONS = ['inbox', 'cost', 'platform health', 'logs', 'log sources', 'recent failures', 'budget', 'settings'] as const;
	type Section = (typeof SECTIONS)[number];
	let sectionErrors = $state<Partial<Record<Section, string>>>({});
	const loadError = $derived.by(() => {
		const failed = SECTIONS.filter((s) => sectionErrors[s]).map((s) => `${s} (${sectionErrors[s]})`);
		return failed.length > 0 ? `Could not load ${failed.join(', ')}.` : null;
	});

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

	/*
	 * Every load on this page reads from the server, not the query cache (`fetchFresh`).
	 * Refresh re-awaited the same eight queries with the same arguments and got back what
	 * it already had, and resolving an inbox item left it on screen as "open", with its
	 * buttons, inviting a second resolve.
	 *
	 * Each section loads on its own. This was one `Promise.all` with no `catch`, so a single
	 * failing query — the budget status, say — left the whole dashboard on a spinner forever
	 * and said nothing. Now the sections that loaded render, and the ones that did not are
	 * named in an error above them.
	 */
	async function loadSection<T>(section: Section, load: Promise<T>, apply: (value: T) => void) {
		try {
			apply(await load);
			sectionErrors[section] = undefined;
		} catch (err) {
			sectionErrors[section] = remoteErrorMessage(err, 'failed');
		}
	}

	async function loadAll() {
		loading = true;
		await Promise.all([
			loadSection('inbox', fetchFresh(listReviewItemsQuery(buildInboxArgs())), (v) => {
				inbox = v;
				inboxError = null;
			}),
			loadSection('cost', fetchFresh(getCostSummary({ period })), (v) => (cost = v)),
			loadSection('platform health', fetchFresh(getOperationalSnapshotQuery()), (v) => (snapshot = v)),
			loadSection('logs', fetchFresh(listAppLogsQuery(buildLogsArgs())), (v) => (logs = v)),
			loadSection('log sources', fetchFresh(countLogsBySourceQuery({ windowMinutes: 60 * 24 })), (v) => (logSources = v)),
			loadSection('recent failures', fetchFresh(listRecentFailuresQuery({ hours: 24, limit: 20 })), (v) => (failures = v)),
			loadSection('budget', fetchFresh(getBudgetStatus()), (v) => (budget = v)),
			loadSection('settings', fetchFresh(getSettings()), (settingsRes) => {
				if (settingsRes?.budgetConfig) {
					budgetConfig = {
						dailyLimit: settingsRes.budgetConfig.dailyLimit ?? null,
						monthlyLimit: settingsRes.budgetConfig.monthlyLimit ?? null,
					};
				}
			}),
		]);
		loading = false;
	}

	function buildInboxArgs() {
		return {
			type: typeFilter ? (typeFilter as ReviewItemType) : undefined,
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
		await loadSection('cost', fetchFresh(getCostSummary({ period })), (v) => (cost = v));
	}

	async function reloadInbox() {
		// A failed filter change is said over the list (`inboxError`), which still holds the
		// previous filter's items; a success also clears a failure the first load reported.
		try {
			inbox = await fetchFresh(listReviewItemsQuery(buildInboxArgs()));
			inboxError = null;
			sectionErrors.inbox = undefined;
		} catch (e) {
			inboxError = remoteErrorMessage(e, 'Could not load the inbox for this filter');
		}
	}

	async function reloadLogs() {
		logsLoading = true;
		await loadSection('logs', fetchFresh(listAppLogsQuery(buildLogsArgs())), (v) => (logs = v));
		logsLoading = false;
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

	{#if loadError}
		<div role="alert" class="alert alert-error py-2 text-sm">{loadError}</div>
	{/if}
	{#if !inbox}
		{#if !loadError}
			<div class="flex justify-center py-20">
				<span class="loading loading-spinner loading-lg text-primary"></span>
			</div>
		{/if}
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
					<span class="badge badge-sm badge-ghost">{inbox?.items.length ?? 0}</span>
				</div>
			{/snippet}
			{#if inboxError}
				<div role="alert" class="alert alert-error mb-3 text-sm" data-testid="inbox-error">
					<span>{inboxError}. The items below are from the previous filter.</span>
				</div>
			{/if}
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
