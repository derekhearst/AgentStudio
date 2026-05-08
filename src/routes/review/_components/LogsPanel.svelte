<script lang="ts">
	import type { listAppLogsQuery, countLogsBySourceQuery } from '$lib/observability/logs.remote';

	type ListResult = Awaited<ReturnType<typeof listAppLogsQuery>>;
	type LogRow = ListResult['logs'][number];
	type CountResult = Awaited<ReturnType<typeof countLogsBySourceQuery>>;

	let {
		logs,
		sources,
		level = $bindable(),
		source = $bindable(),
		search = $bindable(),
		limit = $bindable(),
		loading = false,
		onChange,
	}: {
		logs: LogRow[];
		sources: CountResult['counts'];
		level: 'debug' | 'info' | 'warn' | 'error';
		source: string;
		search: string;
		limit: number;
		loading?: boolean;
		onChange: () => void;
	} = $props();

	let expanded = $state<Set<string>>(new Set());

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

	function levelBadge(lvl: 'debug' | 'info' | 'warn' | 'error'): string {
		if (lvl === 'error') return 'badge-error';
		if (lvl === 'warn') return 'badge-warning';
		if (lvl === 'info') return 'badge-info';
		return 'badge-ghost';
	}

	function toggleExpand(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function loadMore() {
		limit = Math.min(1000, limit < 250 ? 250 : limit + 250);
		onChange();
	}

	function clearFilters() {
		level = 'warn';
		source = '';
		search = '';
		onChange();
	}
</script>

<div class="space-y-2">
	<div class="flex flex-wrap items-end gap-2">
		<label class="flex flex-col gap-1 text-[10px]">
			<span class="font-semibold uppercase tracking-wide opacity-50">Min level</span>
			<select
				class="select select-sm select-bordered text-xs"
				bind:value={level}
				onchange={onChange}
			>
				<option value="debug">debug</option>
				<option value="info">info</option>
				<option value="warn">warn</option>
				<option value="error">error</option>
			</select>
		</label>

		<label class="flex flex-col gap-1 text-[10px]">
			<span class="font-semibold uppercase tracking-wide opacity-50">Source</span>
			<select
				class="select select-sm select-bordered text-xs"
				bind:value={source}
				onchange={onChange}
			>
				<option value="">any</option>
				{#each sources as row (row.source ?? '__none__')}
					{#if row.source}
						<option value={row.source}>{row.source} ({row.count})</option>
					{/if}
				{/each}
			</select>
		</label>

		<label class="flex flex-1 flex-col gap-1 text-[10px]" style="min-width: 12rem">
			<span class="font-semibold uppercase tracking-wide opacity-50">Search message + context</span>
			<input
				class="input input-sm input-bordered text-xs"
				placeholder="text…"
				bind:value={search}
				onkeydown={(e) => { if (e.key === 'Enter') onChange(); }}
				onblur={onChange}
			/>
		</label>

		<button class="btn btn-ghost btn-xs" type="button" onclick={clearFilters}>
			Clear
		</button>
	</div>

	{#if loading && logs.length === 0}
		<div class="flex justify-center py-10">
			<span class="loading loading-spinner loading-md text-primary"></span>
		</div>
	{:else if logs.length === 0}
		<div class="rounded-xl border border-base-300/60 bg-base-200/30 p-6 text-center text-sm text-base-content/55">
			No logs match the current filters.
		</div>
	{:else}
		<ul class="space-y-1">
			{#each logs as log (log.id)}
				{@const isOpen = expanded.has(log.id)}
				<li class="rounded-lg border border-base-300/60 bg-base-100">
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
						<span class="whitespace-nowrap font-mono text-[10px] text-base-content/40">{fmtTs(log.ts)}</span>
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

		{#if logs.length >= limit && limit < 1000}
			<div class="flex justify-center pt-1">
				<button class="btn btn-ghost btn-xs" type="button" onclick={loadMore}>
					Load more ({limit} → {Math.min(1000, limit < 250 ? 250 : limit + 250)})
				</button>
			</div>
		{/if}
	{/if}
</div>
