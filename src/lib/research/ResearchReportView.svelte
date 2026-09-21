<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		getResearchDetailQuery,
		cancelResearchCommand,
	} from '$lib/research/research.remote';
	import { splitReportIntoParts } from '$lib/research/report-render';

	type Detail = NonNullable<Awaited<ReturnType<typeof getResearchDetailQuery>>>;
	type Tab = 'report' | 'sources' | 'trace';

	let { id }: { id: string } = $props();

	let detail = $state<Detail | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let canceling = $state(false);
	let tab = $state<Tab>('report');
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		const researchId = id;
		// Reset state when the target id changes.
		detail = null;
		loading = true;
		error = null;
		tab = 'report';
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		void load(researchId);
		pollTimer = setInterval(() => {
			if (detail && isInFlight(detail.research.status)) void load(researchId);
		}, 3000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	async function load(researchId: string) {
		try {
			detail = await getResearchDetailQuery(researchId);
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load research';
		} finally {
			loading = false;
		}
	}

	function isInFlight(status: string): boolean {
		return ['planning', 'searching', 'fetching', 'reflecting', 'synthesizing'].includes(status);
	}

	async function handleCancel() {
		if (!confirm('Cancel this research run? In-flight LLM calls may still complete in the background.')) return;
		canceling = true;
		try {
			await cancelResearchCommand(id);
			await load(id);
		} finally {
			canceling = false;
		}
	}

	function statusTone(status: string): string {
		switch (status) {
			case 'planning':
			case 'searching':
			case 'fetching':
			case 'reflecting':
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
			case 'plan':
				return 'badge-secondary';
			case 'search':
				return 'badge-info';
			case 'fetch':
				return 'badge-primary';
			case 'extract':
				return 'badge-accent';
			case 'synthesize':
				return 'badge-success';
			default:
				return 'badge-ghost';
		}
	}

	function fmtTime(d: Date | string | null) {
		if (!d) return '—';
		return new Date(d).toLocaleTimeString(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
	}

	const reportParts = $derived(
		detail?.research.report
			? splitReportIntoParts(
					detail.research.report,
					detail.sources.map((s) => ({ id: s.id, url: s.url, title: s.title })),
				)
			: [],
	);

	const inFlight = $derived(detail ? isInFlight(detail.research.status) : false);
</script>

{#if loading && !detail}
	<div class="flex justify-center py-20">
		<span class="loading loading-spinner loading-lg text-primary"></span>
	</div>
{:else if error || !detail}
	<div class="py-20 text-center text-sm text-base-content/55">{error ?? 'Research not found.'}</div>
{:else}
	{@const r = detail.research}
	<div class="flex h-full min-h-0 flex-col">
		<header class="border-b border-base-300/60 px-4 py-3">
			<div class="flex items-start justify-between gap-2">
				<div class="min-w-0 flex-1">
					<h2 class="line-clamp-2 text-base font-semibold leading-tight">{r.query}</h2>
					<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
						<span class="badge badge-sm {statusTone(r.status)}">
							{r.status}{inFlight ? '…' : ''}
						</span>
						<span>· <span class="font-semibold">{detail.sources.length}</span> sources</span>
						<span>· <span class="font-semibold">{detail.sources.filter((s) => s.citedInReport).length}</span> cited</span>
						{#if parseFloat(r.costUsd) > 0}
							<span>· ${parseFloat(r.costUsd).toFixed(4)}</span>
						{/if}
						{#if r.tokensUsed > 0}
							<span>· {r.tokensUsed.toLocaleString()} tokens</span>
						{/if}
					</div>
				</div>
				{#if inFlight}
					<button
						class="btn btn-xs btn-ghost text-error"
						type="button"
						onclick={handleCancel}
						disabled={canceling}
					>
						{canceling ? 'Canceling…' : 'Cancel'}
					</button>
				{/if}
			</div>

			<div role="tablist" class="tabs tabs-boxed mt-3 bg-base-200/40">
				<button
					type="button"
					role="tab"
					class="tab tab-sm {tab === 'report' ? 'tab-active' : ''}"
					onclick={() => (tab = 'report')}
				>
					Report
				</button>
				<button
					type="button"
					role="tab"
					class="tab tab-sm {tab === 'sources' ? 'tab-active' : ''}"
					onclick={() => (tab = 'sources')}
				>
					Sources <span class="ml-1 opacity-60">{detail.sources.length}</span>
				</button>
				<button
					type="button"
					role="tab"
					class="tab tab-sm {tab === 'trace' ? 'tab-active' : ''}"
					onclick={() => (tab = 'trace')}
				>
					Trace <span class="ml-1 opacity-60">{detail.steps.length}</span>
				</button>
			</div>
		</header>

		<div class="flex-1 overflow-y-auto p-4">
			{#if tab === 'report'}
				{#if r.plan && r.plan.length > 0}
					<div class="mb-4">
						<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/45">
							Sub-questions
						</p>
						<ol class="list-inside list-decimal space-y-0.5 text-sm">
							{#each r.plan as q (q)}
								<li>{q}</li>
							{/each}
						</ol>
					</div>
				{/if}

				{#if r.report}
					<div
						class="whitespace-pre-wrap rounded-lg bg-base-200/30 p-3 font-mono text-sm leading-relaxed"
					>
						{#each reportParts as part, i (i)}
							{#if part.type === 'text'}{part.value}{:else if part.url}<a
									href={part.url}
									target="_blank"
									rel="noreferrer noopener"
									class="link link-secondary link-hover font-semibold text-secondary"
									title={part.title ?? part.url}>[{part.n}]</a
								>{:else}<span
									class="badge badge-xs badge-warning"
									title="Citation [{part.n}] — out of range (only {detail.sources.length} sources fetched)"
									>[{part.n}]</span
								>{/if}
						{/each}
					</div>
				{:else if inFlight}
					<p class="py-6 text-center text-sm italic text-base-content/45">
						Synthesizing… auto-refreshes every 3 seconds.
					</p>
				{:else}
					<p class="py-6 text-center text-sm italic text-base-content/45">No report yet.</p>
				{/if}

				{#if r.error}
					<div class="alert alert-error mt-3 py-2 text-xs">
						<span class="font-semibold uppercase tracking-wide">Error:</span>
						<span class="font-mono">{r.error}</span>
					</div>
				{/if}
			{:else if tab === 'sources'}
				{#if detail.sources.length === 0}
					<p class="py-6 text-center text-xs italic text-base-content/45">
						No sources fetched yet.
					</p>
				{:else}
					<ul class="space-y-1.5">
						{#each detail.sources as src, idx (src.id)}
							<li class="rounded-lg border border-base-300/60 bg-base-100 p-2 text-xs">
								<div class="flex items-start gap-1.5">
									<span class="font-mono font-semibold text-base-content/55">[{idx + 1}]</span>
									<a
										href={src.url}
										target="_blank"
										rel="noreferrer noopener"
										class="link link-hover line-clamp-2 flex-1 break-all"
									>
										{src.title || src.url}
									</a>
									{#if src.citedInReport}
										<span
											class="badge badge-xs badge-success"
											title="Cited in the final report">cited</span
										>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			{:else if tab === 'trace'}
				{#if detail.steps.length === 0}
					<p class="py-6 text-center text-xs italic text-base-content/45">
						No steps recorded yet.
					</p>
				{:else}
					<ol class="space-y-1 text-xs">
						{#each detail.steps as step (step.id)}
							<li
								class="flex items-start gap-1.5 rounded-lg border border-base-300/60 bg-base-100 px-2 py-1.5"
							>
								<span class="font-mono font-semibold text-base-content/40">#{step.seq}</span>
								<span class="badge badge-xs {stepKindTone(step.kind)} shrink-0">
									{step.kind}
								</span>
								{#if step.subQuestion}
									<span class="line-clamp-1 flex-1 leading-snug">{step.subQuestion}</span>
								{:else}
									<span class="flex-1"></span>
								{/if}
								<span class="font-mono text-[10px] text-base-content/40">
									{fmtTime(step.startedAt)}
								</span>
							</li>
						{/each}
					</ol>
				{/if}
			{/if}
		</div>

		<footer class="border-t border-base-300/60 px-4 py-2 text-xs text-base-content/55">
			<a class="link link-hover" href="/research/{r.id}">Open full page →</a>
		</footer>
	</div>
{/if}
