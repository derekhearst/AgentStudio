<svelte:head><title>Review Inbox | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import {
		listReviewItemsQuery,
		resolveReviewItemCommand,
	} from '$lib/observability/review.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Result = Awaited<ReturnType<typeof listReviewItemsQuery>>;

	let result = $state<Result | null>(null);
	let loading = $state(false);
	let typeFilter = $state<string>('');
	let statusFilter = $state<string>('open');
	let severityFilter = $state<string>('');
	let expanded = $state<Set<string>>(new Set());

	const TYPES = [
		{ value: '', label: 'All types' },
		{ value: 'approval_request', label: 'Approval request' },
		{ value: 'user_question', label: 'User question' },
		{ value: 'evaluation_failure', label: 'Evaluation failure' },
		{ value: 'job_failure', label: 'Job failure' },
		{ value: 'job_stuck', label: 'Job stuck' },
		{ value: 'hook_failure', label: 'Hook failure' },
		{ value: 'artifact_conflict', label: 'Artifact conflict' },
		{ value: 'memory_conflict', label: 'Memory conflict' },
		{ value: 'policy_override_request', label: 'Policy override request' },
	];

	onMount(() => void load());

	async function load() {
		loading = true;
		try {
			result = await listReviewItemsQuery({
				type: typeFilter ? (typeFilter as 'approval_request') : undefined,
				status: statusFilter ? (statusFilter as 'open') : undefined,
				severity: severityFilter ? (severityFilter as 'info' | 'warning' | 'critical') : undefined,
				openOnly: !statusFilter,
			});
		} finally {
			loading = false;
		}
	}

	async function handleResolve(itemId: string, action: string) {
		const note = prompt(`Resolve action: ${action}\nOptional note:`);
		if (note === null) return;
		try {
			await resolveReviewItemCommand({
				itemId,
				action,
				note: note.trim() || undefined,
				finalStatus: action === 'dismiss' ? 'dismissed' : 'resolved',
			});
			await load();
		} catch (e) {
			alert(e instanceof Error ? e.message : 'Failed to resolve');
		}
	}

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleString();
	}

	function severityTone(severity: string): string {
		switch (severity) {
			case 'critical': return 'badge-error';
			case 'warning': return 'badge-warning';
			case 'info': return 'badge-info';
			default: return 'badge-ghost';
		}
	}

	function statusTone(status: string): string {
		switch (status) {
			case 'open': return 'badge-warning';
			case 'in_progress': return 'badge-info';
			case 'resolved': return 'badge-success';
			case 'dismissed': return 'badge-neutral';
			default: return 'badge-ghost';
		}
	}

	function typeLabel(type: string): string {
		const found = TYPES.find((t) => t.value === type);
		return found?.label ?? type;
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
					<h1 class="text-xl font-bold sm:text-3xl">Review Inbox</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Every action waiting on a human in one place. Admin only.
					</p>
				</div>
				<div class="flex items-center gap-2">
					<select class="select select-sm select-bordered text-xs" bind:value={typeFilter} onchange={() => void load()}>
						{#each TYPES as opt (opt.value)}
							<option value={opt.value}>{opt.label}</option>
						{/each}
					</select>
					<select class="select select-sm select-bordered text-xs" bind:value={statusFilter} onchange={() => void load()}>
						<option value="">Open queue</option>
						<option value="open">Open</option>
						<option value="in_progress">In progress</option>
						<option value="resolved">Resolved</option>
						<option value="dismissed">Dismissed</option>
					</select>
					<select class="select select-sm select-bordered text-xs" bind:value={severityFilter} onchange={() => void load()}>
						<option value="">All severities</option>
						<option value="critical">Critical</option>
						<option value="warning">Warning</option>
						<option value="info">Info</option>
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
			<p class="mt-1 text-xs opacity-70">The Review Inbox is visible only to users with the <code>admin</code> role.</p>
		</div>
	{:else}
		{#if result.rollup.length > 0}
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Last 24h by type + status</h2>
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

		{#if result.items.length === 0}
			<div class="rounded-2xl border border-base-300/60 bg-base-200/30 p-12 text-center text-sm text-base-content/55">
				No review items match the current filters.
			</div>
		{:else}
			<ContentPanel>
				{#snippet header()}
					<div class="flex flex-1 items-center justify-between gap-2">
						<h2 class="font-semibold">Items</h2>
						<span class="badge badge-sm badge-ghost">{result?.items.length ?? 0}</span>
					</div>
				{/snippet}
				<ul class="space-y-1.5">
					{#each result.items as item (item.id)}
						{@const isOpen = expanded.has(item.id)}
						<li class="rounded-xl border border-base-300/60 bg-base-100">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200/40"
								onclick={() => toggleExpand(item.id)}
							>
								<span class="badge badge-xs {severityTone(item.severity)}">{item.severity}</span>
								<span class="badge badge-xs badge-outline">{typeLabel(item.type)}</span>
								<span class="badge badge-xs {statusTone(item.status)}">{item.status}</span>
								<span class="line-clamp-1 flex-1 text-xs leading-tight">{item.summary ?? '(no summary)'}</span>
								<span class="font-mono text-xs text-base-content/40">{fmtDate(item.createdAt)}</span>
								<svg class="size-3 transition-transform {isOpen ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="3 5 6 8 9 5" />
								</svg>
							</button>
							{#if isOpen}
								<div class="space-y-2 border-t border-base-300/60 px-3 py-3 text-xs">
									{#if item.runId}
										<p>
											<span class="font-semibold uppercase tracking-wide opacity-50">Run:</span>
											<a href="/runs/{item.runId}" class="link link-hover ml-1 font-mono">{item.runId}</a>
											<a href="/review/trace/{item.runId}" class="link link-hover ml-2 text-[10px] opacity-70">trace →</a>
										</p>
									{/if}
									{#if item.taskId}
										<p>
											<span class="font-semibold uppercase tracking-wide opacity-50">Task:</span>
											<a href="/tasks/{item.taskId}" class="link link-hover ml-1 font-mono">{item.taskId}</a>
										</p>
									{/if}
									{#if item.jobId}
										<p>
											<span class="font-semibold uppercase tracking-wide opacity-50">Job:</span>
											<a href="/settings/jobs" class="link link-hover ml-1 font-mono">{item.jobId}</a>
										</p>
									{/if}
									{#if Object.keys(item.payload).length > 0}
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Payload</p>
											<pre class="max-h-48 overflow-auto rounded-lg bg-base-200 p-2 text-[10px]">{JSON.stringify(item.payload, null, 2)}</pre>
										</div>
									{/if}
									{#if item.resolution}
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Resolution</p>
											<p>action: <code class="font-mono">{item.resolution.action}</code>{item.resolution.note ? ` — ${item.resolution.note}` : ''}</p>
											{#if item.resolvedAt}
												<p class="text-base-content/55">at {fmtDate(item.resolvedAt)}</p>
											{/if}
										</div>
									{/if}
									{#if item.status === 'open' || item.status === 'in_progress'}
										<div class="flex gap-2 pt-2">
											<button class="btn btn-xs btn-success" type="button" onclick={() => handleResolve(item.id, 'resolve')}>
												Resolve
											</button>
											<button class="btn btn-xs btn-ghost" type="button" onclick={() => handleResolve(item.id, 'dismiss')}>
												Dismiss
											</button>
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
