<svelte:head><title>Jobs | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listJobsQuery } from '$lib/jobs/jobs.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Result = Awaited<ReturnType<typeof listJobsQuery>>;

	let result = $state<Result | null>(null);
	let loading = $state(false);
	let statusFilter = $state<string>('');
	let typeFilter = $state<string>('');
	let failuresOnly = $state(false);
	let expanded = $state<Set<string>>(new Set());

	const STATUSES = ['', 'pending', 'leased', 'running', 'retry_wait', 'completed', 'failed', 'canceled'];

	onMount(() => void load());

	async function load() {
		loading = true;
		try {
			result = await listJobsQuery({
				status: statusFilter ? (statusFilter as 'pending' | 'leased' | 'running' | 'retry_wait' | 'completed' | 'failed' | 'canceled') : undefined,
				type: typeFilter || undefined,
				failuresOnly: failuresOnly || undefined,
			});
		} finally {
			loading = false;
		}
	}

	function fmtDate(d: Date | string | null) {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}

	function statusTone(status: string): string {
		switch (status) {
			case 'pending': return 'badge-ghost';
			case 'leased':
			case 'running': return 'badge-info';
			case 'retry_wait': return 'badge-warning';
			case 'completed': return 'badge-success';
			case 'failed': return 'badge-error';
			case 'canceled': return 'badge-neutral';
			default: return 'badge-ghost';
		}
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
					<h1 class="text-xl font-bold sm:text-3xl">Job queue</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Durable background work — automations, evaluations, mining, etc. Admin only.
					</p>
				</div>
				<div class="flex items-center gap-2">
					<select class="select select-sm select-bordered text-xs" bind:value={statusFilter} onchange={() => void load()}>
						{#each STATUSES as s (s)}
							<option value={s}>{s || 'All statuses'}</option>
						{/each}
					</select>
					<input
						type="text"
						class="input input-sm input-bordered w-32 text-xs"
						placeholder="Type filter…"
						bind:value={typeFilter}
						onchange={() => void load()}
					/>
					<label class="flex cursor-pointer items-center gap-1.5 text-xs">
						<input
							type="checkbox"
							class="toggle toggle-xs toggle-error"
							bind:checked={failuresOnly}
							onchange={() => void load()}
						/>
						<span>Failed only</span>
					</label>
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
		<div role="alert" class="alert alert-warning alert-soft border-warning/40 flex-col items-center text-center">
			<p class="text-sm font-medium">Admin only</p>
			<p class="mt-1 text-xs opacity-70">The job queue dashboard is visible only to users with the <code>admin</code> role.</p>
		</div>
	{:else}
		{#if result.summary.length > 0}
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Last 24h by status</h2>
				{/snippet}
				<div class="grid gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
					{#each result.summary as row (row.status)}
						<div class="rounded-xl border border-base-300/60 bg-base-100 p-2.5">
							<span class="badge badge-xs {statusTone(row.status)}">{row.status}</span>
							<p class="mt-1 text-2xl font-bold leading-tight">{row.total}</p>
						</div>
					{/each}
				</div>
			</ContentPanel>
		{/if}

		{#if result.jobs.length === 0}
			<div class="card card-body bg-base-200/30 border-base-300/60 text-base-content/55 rounded-2xl border p-12 text-center text-sm">
				No jobs match the current filters.
			</div>
		{:else}
			<ContentPanel>
				{#snippet header()}
					<div class="flex flex-1 items-center justify-between gap-2">
						<h2 class="font-semibold">Recent jobs</h2>
						<span class="badge badge-sm badge-ghost">{result?.jobs.length ?? 0}</span>
					</div>
				{/snippet}
				<ul class="space-y-1.5">
					{#each result.jobs as job (job.id)}
						{@const isOpen = expanded.has(job.id)}
						<li class="card card-body bg-base-100 border-base-300/60 rounded-xl border">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200/40"
								onclick={() => toggleExpand(job.id)}
							>
								<span class="badge badge-xs {statusTone(job.status)}">{job.status}</span>
								<span class="font-mono text-xs">{job.type}</span>
								<span class="badge badge-xs badge-outline">{job.queue}</span>
								<span class="text-xs text-base-content/65">attempt {job.attemptCount}/{job.maxAttempts}</span>
								<span class="ml-auto font-mono text-xs text-base-content/40">{fmtDate(job.createdAt)}</span>
								<svg class="size-3 transition-transform {isOpen ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
									<polyline points="3 5 6 8 9 5" />
								</svg>
							</button>
							{#if isOpen}
								<div class="space-y-2 border-t border-base-300/60 px-3 py-3 text-xs">
									<div class="grid gap-2 sm:grid-cols-3">
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Scheduled</p>
											<p>{fmtDate(job.scheduledAt)}</p>
										</div>
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Started</p>
											<p>{fmtDate(job.startedAt)}</p>
										</div>
										<div>
											<p class="font-semibold uppercase tracking-wide opacity-50">Finished</p>
											<p>{fmtDate(job.finishedAt)}</p>
										</div>
									</div>
									{#if job.runId}
										<p>
											<span class="font-semibold uppercase tracking-wide opacity-50">Run:</span>
											<a href="/runs/{job.runId}" class="link link-hover ml-1 font-mono">{job.runId}</a>
										</p>
									{/if}
									{#if job.taskId}
										<p>
											<span class="font-semibold uppercase tracking-wide opacity-50">Task:</span>
											<a href="/tasks/{job.taskId}" class="link link-hover ml-1 font-mono">{job.taskId}</a>
										</p>
									{/if}
									{#if job.error}
										<div>
											<p class="font-semibold uppercase tracking-wide text-error opacity-80">Error</p>
											<pre class="max-h-32 overflow-auto rounded-lg bg-error/10 p-2 text-[10px] text-error">{job.error.message}</pre>
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
