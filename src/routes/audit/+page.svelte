<svelte:head><title>Audit | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listAuditEventsQuery } from '$lib/governance/governance.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Result = Awaited<ReturnType<typeof listAuditEventsQuery>>;
	type Event = Result extends { events: infer E } ? (E extends Array<infer R> ? R : never) : never;

	let result = $state<Result | null>(null);
	let loading = $state(false);
	let actionFilter = $state<string>('');
	let targetTypeFilter = $state<string>('');
	let expanded = $state<Set<string>>(new Set());

	const ACTIONS: Array<{ value: string; label: string }> = [
		{ value: '', label: 'All actions' },
		{ value: 'settings.updated', label: 'Settings updated' },
		{ value: 'settings.reset', label: 'Settings reset' },
		{ value: 'agent.config.updated', label: 'Agent config updated' },
		{ value: 'budget_limit.created', label: 'Budget limit created' },
		{ value: 'budget_limit.updated', label: 'Budget limit updated' },
		{ value: 'budget_limit.deleted', label: 'Budget limit deleted' },
	];

	const TARGET_TYPES: Array<{ value: string; label: string }> = [
		{ value: '', label: 'All targets' },
		{ value: 'settings', label: 'Settings' },
		{ value: 'agent', label: 'Agent' },
		{ value: 'budget_limit', label: 'Budget limit' },
	];

	onMount(() => void load());

	async function load() {
		loading = true;
		try {
			result = await listAuditEventsQuery({
				action: actionFilter || undefined,
				targetType: targetTypeFilter || undefined,
			});
		} finally {
			loading = false;
		}
	}

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleString();
	}

	function actionTone(action: string): string {
		if (action.includes('deleted') || action.includes('reset')) return 'badge-error';
		if (action.includes('created')) return 'badge-success';
		if (action.includes('updated') || action.includes('changed')) return 'badge-info';
		return 'badge-ghost';
	}

	function toggleExpand(id: string) {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Audit log</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Sensitive write paths recorded for compliance & forensics. Admin only.
					</p>
				</div>
				<div class="flex items-center gap-2">
					<select
						class="select select-sm select-bordered text-xs"
						bind:value={actionFilter}
						onchange={() => void load()}
					>
						{#each ACTIONS as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
					<select
						class="select select-sm select-bordered text-xs"
						bind:value={targetTypeFilter}
						onchange={() => void load()}
					>
						{#each TARGET_TYPES as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
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
			<p class="mt-1 text-xs opacity-70">The audit log is visible only to users with the <code>admin</code> role.</p>
		</div>
	{:else if result.events.length === 0}
		<div class="rounded-2xl border border-base-300/60 bg-base-200/30 p-12 text-center text-sm text-base-content/55">
			No audit events match the current filters.
		</div>
	{:else}
		<div class="min-h-0 flex-1 overflow-y-auto">
			<ul class="space-y-2">
				{#each result.events as evt (evt.id)}
					{@const isOpen = expanded.has(evt.id)}
					<li class="rounded-xl border border-base-300/60 bg-base-100">
						<button
							type="button"
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200/40"
							onclick={() => toggleExpand(evt.id)}
						>
							<span class="badge badge-xs {actionTone(evt.action)}">{evt.action}</span>
							<span class="line-clamp-1 flex-1 font-medium leading-tight">{evt.summary ?? '(no summary)'}</span>
							{#if evt.actorUsername}
								<span class="font-mono text-xs text-base-content/55">{evt.actorUsername}</span>
							{/if}
							<span class="font-mono text-xs text-base-content/40">{fmtDate(evt.createdAt)}</span>
							<svg class="size-3 transition-transform {isOpen ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="3 5 6 8 9 5" />
							</svg>
						</button>
						{#if isOpen}
							<div class="space-y-2 border-t border-base-300/60 px-3 py-3 text-xs">
								<div class="grid gap-2 sm:grid-cols-2">
									{#if evt.targetType}
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Target</p>
											<p class="font-mono">{evt.targetType}{evt.targetId ? ` / ${evt.targetId}` : ''}</p>
										</div>
									{/if}
									{#if evt.actorRole}
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Actor</p>
											<p>{evt.actorUsername ?? '(unknown)'} <span class="badge badge-xs badge-ghost ml-1">{evt.actorRole}</span></p>
										</div>
									{/if}
								</div>
								{#if evt.beforeState || evt.afterState}
									<div class="grid gap-2 lg:grid-cols-2">
										{#if evt.beforeState}
											<div>
												<p class="mb-1 font-semibold uppercase tracking-wide opacity-50">Before</p>
												<pre class="max-h-48 overflow-auto rounded-lg bg-base-200 p-2 text-[10px]">{JSON.stringify(evt.beforeState, null, 2)}</pre>
											</div>
										{/if}
										{#if evt.afterState}
											<div>
												<p class="mb-1 font-semibold uppercase tracking-wide opacity-50">After</p>
												<pre class="max-h-48 overflow-auto rounded-lg bg-base-200 p-2 text-[10px]">{JSON.stringify(evt.afterState, null, 2)}</pre>
											</div>
										{/if}
									</div>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
