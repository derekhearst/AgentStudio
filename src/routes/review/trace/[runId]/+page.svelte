<svelte:head><title>Run Trace | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { getRunTraceQuery } from '$lib/observability/review.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';

	type Result = Awaited<ReturnType<typeof getRunTraceQuery>>;

	const runId = $derived(page.params.runId ?? '');

	let result = $state<Result | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let expanded = $state<Set<number>>(new Set());

	onMount(() => void load());

	async function load() {
		loading = true;
		error = null;
		try {
			result = await getRunTraceQuery(runId);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load trace';
		} finally {
			loading = false;
		}
	}

	function fmtDate(d: Date | string | null | undefined) {
		if (!d) return '—';
		return new Date(d).toLocaleString();
	}

	function fmtDuration(ms: number | null | undefined) {
		if (ms == null) return '—';
		if (ms < 1000) return `${ms}ms`;
		const s = ms / 1000;
		if (s < 60) return `${s.toFixed(1)}s`;
		const m = Math.floor(s / 60);
		const rs = Math.round(s - m * 60);
		return `${m}m ${rs}s`;
	}

	function statusTone(status: string): string {
		switch (status) {
			case 'running':
				return 'badge-primary';
			case 'completed':
				return 'badge-success';
			case 'failed':
				return 'badge-error';
			case 'canceled':
				return 'badge-neutral';
			default:
				return 'badge-ghost';
		}
	}

	function kindTone(kind: string): string {
		switch (kind) {
			case 'tool_call':
				return 'badge-info';
			case 'round_start':
			case 'round_end':
				return 'badge-ghost';
			case 'compaction':
				return 'badge-warning';
			case 'approval':
				return 'badge-warning';
			case 'subagent':
				return 'badge-secondary';
			default:
				return 'badge-outline';
		}
	}

	function spanLabel(span: Record<string, unknown>): string {
		const kind = String(span.kind ?? 'unknown');
		if (kind === 'tool_call' && typeof span.toolName === 'string') return span.toolName;
		if (kind === 'subagent' && typeof span.agentName === 'string') return span.agentName;
		return kind;
	}

	function elapsedSinceStart(span: Record<string, unknown>, startedAt: string | Date | null): string {
		if (!startedAt || typeof span.startedAt !== 'string') return '';
		const elapsedMs = new Date(span.startedAt).getTime() - new Date(startedAt).getTime();
		if (Number.isNaN(elapsedMs) || elapsedMs < 0) return '';
		return `+${fmtDuration(elapsedMs)}`;
	}

	function toggle(seq: number) {
		const next = new Set(expanded);
		if (next.has(seq)) next.delete(seq);
		else next.add(seq);
		expanded = next;
	}

	function spanSuccessGlyph(span: Record<string, unknown>): string {
		if (span.success === true) return '✓';
		if (span.success === false) return '✗';
		return '';
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader
		title="Run trace"
		crumbs={[{ label: 'Review', href: '/review' }]}
		backHref="/review"
		subtitle={runId}
	>
		{#snippet actions()}
			<a class="btn btn-ghost btn-xs" href="/runs/{runId}">Run detail</a>
			<button class="btn btn-ghost btn-xs" type="button" onclick={() => void load()} disabled={loading}>
				{loading ? 'Loading…' : 'Refresh'}
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-3 sm:space-y-4">

	{#if !result}
		<div class="flex justify-center py-20">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if result.adminOnly}
		<div class="alert alert-warning alert-soft border-warning/40 p-6 text-center">
			<p class="text-sm font-medium">Admin only</p>
			<p class="mt-1 text-xs opacity-70">
				The trace viewer is visible only to users with the <code>admin</code> role.
			</p>
		</div>
	{:else if error}
		<div class="alert alert-error alert-soft border-error/40 p-6 text-sm text-error">
			{error}
		</div>
	{:else if !result.trace}
		<div class="card card-body bg-base-200/30 border-base-300/60 rounded-2xl border p-12 text-center text-sm text-base-content/55">
			No trace recorded for this run. Run-trace recording is best-effort — older runs or
			runs that failed before the first append won't have a trace row.
		</div>
	{:else}
		{@const tr = result.trace}
		{@const spans = tr.trace ?? []}
		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
					<h2 class="font-semibold">Summary</h2>
					<span class="badge {statusTone(tr.status)}">{tr.status}</span>
				</div>
			{/snippet}
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
					<p class="text-[10px] uppercase tracking-wide text-base-content/55">Started</p>
					<p class="mt-1 font-mono text-xs">{fmtDate(tr.startedAt)}</p>
				</div>
				<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
					<p class="text-[10px] uppercase tracking-wide text-base-content/55">Finished</p>
					<p class="mt-1 font-mono text-xs">{fmtDate(tr.finishedAt)}</p>
				</div>
				<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
					<p class="text-[10px] uppercase tracking-wide text-base-content/55">Rounds / Tool calls</p>
					<p class="mt-1 text-2xl font-bold leading-tight">{tr.roundCount} / {tr.toolCallCount}</p>
				</div>
				<div class="rounded-xl border border-base-300/60 bg-base-100 p-3">
					<p class="text-[10px] uppercase tracking-wide text-base-content/55">Cost USD</p>
					<p class="mt-1 text-2xl font-bold leading-tight">${tr.costUsd ?? '0'}</p>
				</div>
			</div>
		</ContentPanel>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 items-center justify-between gap-2">
					<h2 class="font-semibold">Timeline</h2>
					<span class="badge badge-sm badge-ghost">{spans.length} spans</span>
				</div>
			{/snippet}
			{#if spans.length === 0}
				<p class="rounded-xl border border-base-300/60 bg-base-200/30 p-6 text-center text-sm text-base-content/55">
					No spans recorded yet. The run is either still starting or recorded no events.
				</p>
			{:else}
				<ol class="space-y-1">
					{#each spans as span, idx (span.seq ?? idx)}
						{@const seq = typeof span.seq === 'number' ? span.seq : idx}
						{@const isOpen = expanded.has(seq)}
						<li class="card card-body bg-base-100 border-base-300/60 rounded-xl border">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200/40"
								onclick={() => toggle(seq)}
							>
								<span class="w-8 text-right font-mono text-[10px] text-base-content/40">#{seq}</span>
								<span class="badge badge-xs {kindTone(String(span.kind ?? ''))}">{String(span.kind ?? '')}</span>
								<span class="line-clamp-1 flex-1 text-xs leading-tight">{spanLabel(span)}</span>
								<span class="font-mono text-[10px] text-base-content/40">
									{elapsedSinceStart(span, tr.startedAt)}
								</span>
								<span class="font-mono text-[10px] text-base-content/55">
									{fmtDuration(typeof span.durationMs === 'number' ? span.durationMs : null)}
								</span>
								<span class="w-3 text-center text-xs {span.success === false ? 'text-error' : span.success === true ? 'text-success' : 'text-base-content/30'}">
									{spanSuccessGlyph(span)}
								</span>
								<svg
									class="size-3 transition-transform {isOpen ? 'rotate-180' : ''}"
									viewBox="0 0 12 12"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<polyline points="3 5 6 8 9 5" />
								</svg>
							</button>
							{#if isOpen}
								<div class="border-t border-base-300/60 px-3 py-3">
									<pre class="max-h-72 overflow-auto rounded-lg bg-base-200 p-2 text-[10px]">{JSON.stringify(span, null, 2)}</pre>
								</div>
							{/if}
						</li>
					{/each}
				</ol>
			{/if}
		</ContentPanel>

		{#if tr.sessionId || tr.jobId}
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Linked records</h2>
				{/snippet}
				<dl class="space-y-1 text-xs">
					{#if tr.sessionId}
						<div class="flex items-center gap-2">
							<dt class="w-20 font-semibold uppercase tracking-wide opacity-50">Session</dt>
							<dd class="font-mono">{tr.sessionId}</dd>
						</div>
					{/if}
					{#if tr.jobId}
						<div class="flex items-center gap-2">
							<dt class="w-20 font-semibold uppercase tracking-wide opacity-50">Job</dt>
							<dd>
								<a href="/settings/jobs" class="link link-hover font-mono">{tr.jobId}</a>
							</dd>
						</div>
					{/if}
				</dl>
			</ContentPanel>
		{/if}
	{/if}
	</div>
</div>
