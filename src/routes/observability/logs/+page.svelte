<svelte:head><title>Logs | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { listAppLogsQuery, countLogsBySourceQuery } from '$lib/observability/logs.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type ListResult = Awaited<ReturnType<typeof listAppLogsQuery>>;
	type LogRow = ListResult['logs'][number];
	type CountResult = Awaited<ReturnType<typeof countLogsBySourceQuery>>;

	let logs = $state<LogRow[]>([]);
	let counts = $state<CountResult['counts']>([]);
	let loading = $state(false);
	let countsWindow = $state(60);

	let minLevel = $state<'debug' | 'info' | 'warn' | 'error'>('info');
	let sourceFilter = $state('');
	let search = $state('');
	let sinceMinutes = $state<number | null>(null);
	let limit = $state(200);
	let autoRefresh = $state(false);

	let expanded = $state<Set<string>>(new Set());

	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		void load();
		void loadCounts();
	});

	onDestroy(() => {
		if (refreshTimer) clearInterval(refreshTimer);
	});

	$effect(() => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
		if (autoRefresh) {
			refreshTimer = setInterval(() => {
				void load();
				void loadCounts();
			}, 10_000);
		}
	});

	async function load() {
		loading = true;
		try {
			const sinceISO =
				sinceMinutes !== null ? new Date(Date.now() - sinceMinutes * 60_000).toISOString() : undefined;
			const result = await listAppLogsQuery({
				minLevel,
				source: sourceFilter || undefined,
				search: search.trim() || undefined,
				sinceISO,
				limit,
			});
			logs = result.logs;
		} finally {
			loading = false;
		}
	}

	async function loadCounts() {
		const result = await countLogsBySourceQuery({ windowMinutes: countsWindow });
		counts = result.counts;
	}

	function fmtTs(d: Date | string) {
		const date = new Date(d);
		const now = new Date();
		const sameDay =
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate();
		const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		return sameDay ? time : `${date.toLocaleDateString()} ${time}`;
	}

	function levelBadge(level: 'debug' | 'info' | 'warn' | 'error'): string {
		if (level === 'error') return 'badge-error';
		if (level === 'warn') return 'badge-warning';
		if (level === 'info') return 'badge-info';
		return 'badge-ghost';
	}

	function toggleExpand(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function setSourceFromCount(source: string | null) {
		sourceFilter = source ?? '';
		void load();
	}

	function clearFilters() {
		minLevel = 'info';
		sourceFilter = '';
		search = '';
		sinceMinutes = null;
		void load();
	}
</script>

<div class="flex h-full min-h-0 flex-col gap-3 sm:gap-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Logs</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Server-side log lines from the app, persisted for ~14 days. Refresh shows the most recent entries first.
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-2">
					<label class="label cursor-pointer gap-1 text-xs">
						<input type="checkbox" class="checkbox checkbox-xs" bind:checked={autoRefresh} />
						<span>Auto 10s</span>
					</label>
					<button class="btn btn-ghost btn-xs" type="button" onclick={() => { void load(); void loadCounts(); }} disabled={loading}>
						{loading ? 'Loading…' : 'Refresh'}
					</button>
				</div>
			</div>
		{/snippet}
	</ContentPanel>

	<div class="grid gap-3 lg:grid-cols-[18rem_1fr]">
		<!-- Sidebar: source counts + filters -->
		<aside class="flex flex-col gap-3">
			<ContentPanel>
				{#snippet header()}
					<h2 class="text-sm font-semibold">Filters</h2>
				{/snippet}
				<div class="flex flex-col gap-2 p-3 text-xs">
					<label class="flex flex-col gap-1">
						<span class="font-semibold uppercase tracking-wide opacity-50">Min level</span>
						<select
							class="select select-sm select-bordered text-xs"
							bind:value={minLevel}
							onchange={() => void load()}
						>
							<option value="debug">debug</option>
							<option value="info">info</option>
							<option value="warn">warn</option>
							<option value="error">error</option>
						</select>
					</label>

					<label class="flex flex-col gap-1">
						<span class="font-semibold uppercase tracking-wide opacity-50">Source</span>
						<input
							class="input input-sm input-bordered text-xs"
							placeholder="any"
							bind:value={sourceFilter}
							onchange={() => void load()}
						/>
					</label>

					<label class="flex flex-col gap-1">
						<span class="font-semibold uppercase tracking-wide opacity-50">Search message + context</span>
						<input
							class="input input-sm input-bordered text-xs"
							placeholder="text…"
							bind:value={search}
							onkeydown={(e) => { if (e.key === 'Enter') void load(); }}
						/>
					</label>

					<label class="flex flex-col gap-1">
						<span class="font-semibold uppercase tracking-wide opacity-50">Since (minutes)</span>
						<select
							class="select select-sm select-bordered text-xs"
							bind:value={sinceMinutes}
							onchange={() => void load()}
						>
							<option value={null}>any</option>
							<option value={5}>5m</option>
							<option value={15}>15m</option>
							<option value={60}>1h</option>
							<option value={6 * 60}>6h</option>
							<option value={24 * 60}>24h</option>
							<option value={7 * 24 * 60}>7d</option>
						</select>
					</label>

					<label class="flex flex-col gap-1">
						<span class="font-semibold uppercase tracking-wide opacity-50">Limit</span>
						<select
							class="select select-sm select-bordered text-xs"
							bind:value={limit}
							onchange={() => void load()}
						>
							<option value={50}>50</option>
							<option value={200}>200</option>
							<option value={500}>500</option>
							<option value={1000}>1000</option>
						</select>
					</label>

					<button class="btn btn-ghost btn-xs mt-1" type="button" onclick={clearFilters}>
						Clear filters
					</button>
				</div>
			</ContentPanel>

			<ContentPanel>
				{#snippet header()}
					<div class="flex items-center justify-between gap-2">
						<h2 class="text-sm font-semibold">By source</h2>
						<select
							class="select select-xs select-bordered text-xs"
							bind:value={countsWindow}
							onchange={() => void loadCounts()}
						>
							<option value={15}>15m</option>
							<option value={60}>1h</option>
							<option value={6 * 60}>6h</option>
							<option value={24 * 60}>24h</option>
						</select>
					</div>
				{/snippet}
				<div class="p-2">
					{#if counts.length === 0}
						<p class="px-1 py-3 text-xs text-base-content/55">No logs in window.</p>
					{:else}
						<ul class="flex flex-col">
							{#each counts as row (row.source ?? '__none__')}
								<li>
									<button
										type="button"
										class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-base-200/40"
										class:font-semibold={row.source === sourceFilter || (!row.source && !sourceFilter)}
										onclick={() => setSourceFromCount(row.source)}
									>
										<span class="font-mono truncate">{row.source ?? '(no source)'}</span>
										<span class="font-mono opacity-60">{row.count}</span>
									</button>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			</ContentPanel>
		</aside>

		<!-- Log list -->
		<section class="min-h-0 flex-1 overflow-y-auto">
			{#if loading && logs.length === 0}
				<div class="flex justify-center py-20">
					<span class="loading loading-spinner loading-lg text-primary"></span>
				</div>
			{:else if logs.length === 0}
				<div class="card card-body bg-base-200/30 border-base-300/60 rounded-2xl border p-12 text-center text-sm text-base-content/55">
					No logs match the current filters.
				</div>
			{:else}
				<ul class="space-y-1">
					{#each logs as log (log.id)}
						{@const isOpen = expanded.has(log.id)}
						<li class="card bg-base-100 border-base-300/60 rounded-lg border">
							<button
								type="button"
								class="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-base-200/40"
								onclick={() => toggleExpand(log.id)}
							>
								<span class="badge badge-xs {levelBadge(log.level)}">{log.level}</span>
								{#if log.source}
									<span class="badge badge-xs badge-ghost font-mono">{log.source}</span>
								{/if}
								<span class="line-clamp-2 flex-1 leading-tight">{log.message}</span>
								<span class="font-mono text-[10px] text-base-content/40 whitespace-nowrap">{fmtTs(log.ts)}</span>
								<svg class="size-3 transition-transform {isOpen ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="3 5 6 8 9 5" />
								</svg>
							</button>
							{#if isOpen}
								<div class="space-y-2 border-t border-base-300/60 px-3 py-2 text-[11px]">
									<div class="grid gap-2 sm:grid-cols-3">
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Time</p>
											<p class="font-mono">{new Date(log.ts).toISOString()}</p>
										</div>
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Level</p>
											<p class="font-mono">{log.level}</p>
										</div>
										{#if log.username}
											<div>
												<p class="font-semibold uppercase tracking-wide opacity-50">User</p>
												<p>{log.username}</p>
											</div>
										{/if}
									</div>
									{#if log.context}
										<div>
											<p class="mb-1 font-semibold uppercase tracking-wide opacity-50">Context</p>
											<pre class="max-h-72 overflow-auto rounded-lg bg-base-200 p-2 text-[10px]">{JSON.stringify(log.context, null, 2)}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</div>
