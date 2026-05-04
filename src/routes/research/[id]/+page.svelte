<svelte:head><title>{detail?.research.query.slice(0, 60) ?? 'Research'} | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount, onDestroy } from 'svelte';
	import {
		getResearchDetailQuery,
		cancelResearchCommand,
	} from '$lib/research/research.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	type Detail = NonNullable<Awaited<ReturnType<typeof getResearchDetailQuery>>>;

	const researchId = $derived(page.params.id ?? '');

	let detail = $state<Detail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let canceling = $state(false);

	onMount(() => {
		void load();
		// Poll every 3s while in-flight so the user sees the trace fill in live.
		pollTimer = setInterval(() => {
			if (detail && isInFlight(detail.research.status)) void load();
		}, 3000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	function isInFlight(status: string): boolean {
		return ['planning', 'searching', 'fetching', 'synthesizing'].includes(status);
	}

	async function load() {
		try {
			detail = await getResearchDetailQuery(researchId);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load research';
		} finally {
			loading = false;
		}
	}

	async function handleCancel() {
		if (!confirm('Cancel this research run? In-flight LLM calls may still complete in the background.')) return;
		canceling = true;
		try {
			await cancelResearchCommand(researchId);
			await load();
		} finally {
			canceling = false;
		}
	}

	function statusTone(status: string): string {
		switch (status) {
			case 'planning':
			case 'searching':
			case 'fetching':
			case 'synthesizing':
				return 'badge-info';
			case 'complete':
				return 'badge-success';
			case 'failed':
				return 'badge-error';
			case 'canceled':
				return 'badge-neutral';
			default:
				return 'badge-ghost';
		}
	}

	function stepKindTone(kind: string): string {
		switch (kind) {
			case 'plan': return 'badge-secondary';
			case 'search': return 'badge-info';
			case 'fetch': return 'badge-primary';
			case 'extract': return 'badge-accent';
			case 'synthesize': return 'badge-success';
			default: return 'badge-ghost';
		}
	}

	function fmtDate(d: Date | string | null) {
		if (!d) return '—';
		return new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}
</script>

{#if loading}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="py-20 text-center text-sm text-base-content/55">{error ?? 'Research not found.'}</div>
{:else}
	{@const r = detail.research}
	{@const inFlight = isInFlight(r.status)}
	<section class="space-y-3 sm:space-y-4">
		<a class="btn btn-sm btn-ghost -ml-1 w-fit" href="/research">← All research</a>

		<ContentPanel>
			{#snippet header()}
				<div class="flex flex-1 flex-wrap items-start justify-between gap-2">
					<div class="min-w-0 flex-1">
						<h1 class="text-lg font-bold leading-tight sm:text-xl">{r.query}</h1>
						<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
							<span class="badge badge-sm {statusTone(r.status)}">{r.status}{inFlight ? '…' : ''}</span>
							{#if parseFloat(r.costUsd) > 0}
								<span>· ${parseFloat(r.costUsd).toFixed(4)}</span>
							{/if}
							{#if r.tokensUsed > 0}
								<span>· {r.tokensUsed.toLocaleString()} tokens</span>
							{/if}
							{#if r.jobId}
								<a href="/settings/jobs?type=research_run" class="link link-hover">· Job log</a>
							{/if}
						</div>
					</div>
					{#if inFlight}
						<button class="btn btn-sm btn-ghost text-error" type="button" onclick={handleCancel} disabled={canceling}>
							{canceling ? 'Canceling…' : 'Cancel'}
						</button>
					{/if}
				</div>
			{/snippet}

			{#if r.plan && r.plan.length > 0}
				<div>
					<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/45">Sub-questions</p>
					<ol class="list-inside list-decimal space-y-0.5 text-sm">
						{#each r.plan as q (q)}
							<li>{q}</li>
						{/each}
					</ol>
				</div>
			{/if}

			{#if r.error}
				<div class="alert alert-error mt-3 py-2 text-xs">
					<span class="font-semibold uppercase tracking-wide">Error:</span>
					<span class="font-mono">{r.error}</span>
				</div>
			{/if}
		</ContentPanel>

		<div class="grid gap-3 lg:grid-cols-[1fr_320px]">
			<ContentPanel>
				{#snippet header()}
					<h2 class="font-semibold">Report</h2>
				{/snippet}
				{#if r.report}
					<pre class="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg bg-base-200/30 p-3 text-sm leading-relaxed">{r.report}</pre>
				{:else if inFlight}
					<p class="py-6 text-center text-sm italic text-base-content/45">
						Synthesizing… this page auto-refreshes every 3 seconds.
					</p>
				{:else}
					<p class="py-6 text-center text-sm italic text-base-content/45">No report yet.</p>
				{/if}
			</ContentPanel>

			<div class="space-y-3">
				<ContentPanel>
					{#snippet header()}
						<div class="flex flex-1 items-center justify-between gap-2">
							<h3 class="font-semibold">Sources</h3>
							<span class="badge badge-sm badge-ghost">{detail?.sources.length ?? 0}</span>
						</div>
					{/snippet}
					{#if detail.sources.length === 0}
						<p class="py-3 text-center text-xs italic text-base-content/45">No sources fetched yet.</p>
					{:else}
						<ul class="space-y-1.5">
							{#each detail.sources as src, idx (src.id)}
								<li class="rounded-lg border border-base-300/60 bg-base-100 p-2 text-xs">
									<div class="flex items-start gap-1.5">
										<span class="font-mono font-semibold text-base-content/55">[{idx + 1}]</span>
										<a href={src.url} target="_blank" rel="noreferrer noopener" class="line-clamp-2 link link-hover flex-1 break-all">
											{src.title || src.url}
										</a>
										{#if src.citedInReport}
											<span class="badge badge-xs badge-success" title="Cited in the final report">cited</span>
										{/if}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</ContentPanel>

				<ContentPanel>
					{#snippet header()}
						<div class="flex flex-1 items-center justify-between gap-2">
							<h3 class="font-semibold">Trace</h3>
							<span class="badge badge-sm badge-ghost">{detail?.steps.length ?? 0}</span>
						</div>
					{/snippet}
					{#if detail.steps.length === 0}
						<p class="py-3 text-center text-xs italic text-base-content/45">No steps recorded yet.</p>
					{:else}
						<ol class="space-y-1 text-xs">
							{#each detail.steps as step (step.id)}
								<li class="flex items-start gap-1.5 rounded-lg border border-base-300/60 bg-base-100 px-2 py-1.5">
									<span class="font-mono font-semibold text-base-content/40">#{step.seq}</span>
									<span class="badge badge-xs {stepKindTone(step.kind)} shrink-0">{step.kind}</span>
									{#if step.subQuestion}
										<span class="line-clamp-1 flex-1 leading-snug">{step.subQuestion}</span>
									{:else}
										<span class="flex-1"></span>
									{/if}
									<span class="font-mono text-[10px] text-base-content/40">{fmtDate(step.startedAt)}</span>
								</li>
							{/each}
						</ol>
					{/if}
				</ContentPanel>
			</div>
		</div>
	</section>
{/if}
