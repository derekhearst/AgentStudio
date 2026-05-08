<svelte:head><title>Hooks | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listHookInvocationsQuery } from '$lib/hooks/hooks.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	type Result = Awaited<ReturnType<typeof listHookInvocationsQuery>>;

	let result = $state<Result | null>(null);
	let loading = $state(false);
	let eventFilter = $state<string>('');
	let kindFilter = $state<string>('');
	let failuresOnly = $state(false);
	let expanded = $state<Set<string>>(new Set());

	const EVENTS: Array<{ value: string; label: string }> = [
		{ value: '', label: 'All events' },
		{ value: 'before_run', label: 'before_run' },
		{ value: 'after_run', label: 'after_run' },
		{ value: 'before_round', label: 'before_round' },
		{ value: 'after_round', label: 'after_round' },
		{ value: 'before_tool', label: 'before_tool' },
		{ value: 'after_tool', label: 'after_tool' },
		{ value: 'on_compact', label: 'on_compact' },
		{ value: 'on_evaluator', label: 'on_evaluator' },
		{ value: 'on_subagent_spawn', label: 'on_subagent_spawn' },
		{ value: 'on_approval_required', label: 'on_approval_required' },
		{ value: 'on_user_question', label: 'on_user_question' },
		{ value: 'on_run_failed', label: 'on_run_failed' },
		{ value: 'on_skill_loaded', label: 'on_skill_loaded' },
		{ value: 'on_tool_output_archived', label: 'on_tool_output_archived' },
	];

	onMount(() => void load());

	async function load() {
		loading = true;
		try {
			result = await listHookInvocationsQuery({
				event: eventFilter || undefined,
				hookKind: kindFilter ? (kindFilter as 'builtin' | 'skill') : undefined,
				failuresOnly: failuresOnly || undefined,
			});
		} finally {
			loading = false;
		}
	}

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleString();
	}

	function toggleExpand(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function eventTone(event: string): string {
		if (event.startsWith('after_run')) return 'badge-success';
		if (event.startsWith('after_tool')) return 'badge-info';
		if (event.startsWith('on_run_failed')) return 'badge-error';
		if (event.startsWith('on_compact') || event.startsWith('on_user_question')) return 'badge-warning';
		return 'badge-ghost';
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title="Hook invocations"
		crumbs={[{ label: 'Settings', href: '/settings' }]}
		backHref="/settings"
		subtitle="Hooks dispatched in last runs · admin only"
	>
		{#snippet actions()}
			<button class="btn btn-ghost btn-xs" type="button" onclick={() => void load()} disabled={loading}>
				{loading ? 'Loading…' : 'Refresh'}
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-3 sm:space-y-4">

		<div class="flex flex-wrap items-center gap-2">
			<select
				class="select select-xs select-bordered text-xs"
				bind:value={eventFilter}
				onchange={() => void load()}
			>
				{#each EVENTS as opt (opt.value)}
					<option value={opt.value}>{opt.label}</option>
				{/each}
			</select>
			<select
				class="select select-xs select-bordered text-xs"
				bind:value={kindFilter}
				onchange={() => void load()}
			>
				<option value="">All kinds</option>
				<option value="builtin">Built-in</option>
				<option value="skill">Skill-based</option>
			</select>
			<label class="flex cursor-pointer items-center gap-1.5 text-xs">
				<input
					type="checkbox"
					class="toggle toggle-xs toggle-error"
					bind:checked={failuresOnly}
					onchange={() => void load()}
				/>
				<span>Failures only</span>
			</label>
		</div>

	{#if !result}
		<div class="flex justify-center py-20">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if result.adminOnly}
		<div role="alert" class="alert alert-warning alert-soft border-warning/40 flex-col items-center text-center">
			<p class="text-sm font-medium">Admin only</p>
			<p class="mt-1 text-xs opacity-70">Hook invocations are visible only to users with the <code>admin</code> role.</p>
		</div>
	{:else if 'loadError' in result && result.loadError}
		<div role="alert" class="alert alert-error alert-soft border-error/40 flex-col items-start">
			<p class="text-sm font-medium">Failed to load hook invocations</p>
			<p class="mt-1 text-xs opacity-80">{result.loadError}</p>
			<p class="mt-2 text-xs opacity-60">Check that database migrations are applied in this environment (look for <code>0028_hook_invocations.sql</code>).</p>
		</div>
	{:else}
		{#if result.summary.length > 0}
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Last 24h by event</h2>
				{/snippet}
				<div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{#each result.summary as row (row.event)}
						{@const failureRate = row.total > 0 ? Math.round((row.failures / row.total) * 100) : 0}
						{@const tone = row.failures === 0 ? 'border-success/40 bg-success/5' : failureRate > 20 ? 'border-error/40 bg-error/5' : 'border-warning/40 bg-warning/5'}
						<div class="rounded-xl border {tone} p-2.5">
							<p class="font-mono text-xs font-semibold">{row.event}</p>
							<p class="mt-1 text-xs text-base-content/70">
								<span class="font-medium">{row.total}</span> calls
								{#if row.failures > 0}
									· <span class="text-error font-medium">{row.failures} failed ({failureRate}%)</span>
								{/if}
							</p>
							<p class="text-[10px] text-base-content/50">avg {row.avgDurationMs}ms</p>
						</div>
					{/each}
				</div>
			</ContentPanel>
		{/if}

		{#if result.invocations.length === 0}
			<div class="card card-body bg-base-200/30 border-base-300/60 text-base-content/55 rounded-2xl border p-12 text-center text-sm">
				No hook invocations match the current filters.
			</div>
		{:else}
			<ContentPanel>
				{#snippet header()}
					<div class="flex flex-1 items-center justify-between gap-2">
						<h2 class="font-semibold">Recent invocations</h2>
						<span class="badge badge-sm badge-ghost">{result?.invocations.length ?? 0}</span>
					</div>
				{/snippet}
				<ul class="space-y-1.5">
					{#each result.invocations as inv (inv.id)}
						{@const isOpen = expanded.has(inv.id)}
						<li class="card card-body bg-base-100 border-base-300/60 rounded-xl border">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200/40"
								onclick={() => toggleExpand(inv.id)}
							>
								<span class="badge badge-xs {eventTone(inv.event)}">{inv.event}</span>
								<span class="badge badge-xs badge-outline">{inv.hookKind}</span>
								<span class="line-clamp-1 flex-1 font-mono text-xs leading-tight">{inv.hookRef}</span>
								{#if !inv.success}
									<span class="badge badge-xs badge-error">failed</span>
								{/if}
								<span class="font-mono text-xs text-base-content/55 tabular-nums">{inv.durationMs}ms</span>
								<span class="font-mono text-xs text-base-content/40">{fmtDate(inv.createdAt)}</span>
								{#if inv.error || inv.runId}
									<svg class="size-3 transition-transform {isOpen ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
										<polyline points="3 5 6 8 9 5" />
									</svg>
								{/if}
							</button>
							{#if isOpen}
								<div class="space-y-2 border-t border-base-300/60 px-3 py-3 text-xs">
									{#if inv.runId}
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Run</p>
											<a href="/runs/{inv.runId}" class="link link-hover font-mono">{inv.runId}</a>
										</div>
									{/if}
									{#if inv.error}
										<div>
											<p class="font-semibold uppercase tracking-wide text-error opacity-80">Error</p>
											<pre class="max-h-32 overflow-auto rounded-lg bg-error/10 p-2 text-[10px] text-error">{inv.error}</pre>
										</div>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</ContentPanel>
		{/if}
	{/if}
	</div>
</div>
