<svelte:head><title>Research | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		listResearchQuery,
		startResearchCommand,
	} from '$lib/research/research.remote';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';
	import ModelSelector from '$lib/llm/ModelSelector.svelte';

	type ResearchRow = Awaited<ReturnType<typeof listResearchQuery>>[number];

	let runs = $state<ResearchRow[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let formOpen = $state(false);
	let formQuery = $state('');
	let formError = $state<string | null>(null);
	let starting = $state(false);
	// Defaults to Sonnet 4.6 (matches DEFAULT_RESEARCH_CONFIG and the chat composer default).
	// Drives planner + reflection + synthesizer phases of the orchestrator for the new run.
	let formModel = $state('anthropic/claude-sonnet-4-6');
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		void load();
		// Poll every 4s while there are in-flight runs so the user sees progress.
		pollTimer = setInterval(() => {
			const hasInFlight = runs.some((r) => isInFlight(r.status));
			if (hasInFlight) void load();
		}, 4000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	function isInFlight(status: string): boolean {
		return ['planning', 'searching', 'fetching', 'reflecting', 'synthesizing'].includes(status);
	}

	async function load() {
		try {
			runs = await listResearchQuery({});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load research';
		} finally {
			loading = false;
		}
	}

	async function submitStart(event: Event) {
		event.preventDefault();
		const q = formQuery.trim();
		if (q.length < 8) {
			formError = 'Query must be at least 8 characters';
			return;
		}
		starting = true;
		formError = null;
		try {
			const result = await startResearchCommand({ query: q, model: formModel });
			formQuery = '';
			formOpen = false;
			await goto(`/research/${result.research.id}`);
		} catch (e) {
			formError = e instanceof Error ? e.message : 'Failed to start research';
		} finally {
			starting = false;
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

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleString();
	}

	function relativeTime(d: Date | string): string {
		const diff = Date.now() - new Date(d).getTime();
		if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return `${Math.floor(diff / 86_400_000)}d ago`;
	}
</script>

<div class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<ContentPanel>
		{#snippet header()}
			<div class="flex flex-1 flex-wrap items-center justify-between gap-2">
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Research</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						Multi-step Deep Research runs — plan → search → fetch → synthesize → cited report.
					</p>
				</div>
				<button class="btn btn-sm btn-primary" type="button" onclick={() => (formOpen = !formOpen)}>
					{formOpen ? 'Cancel' : '+ New research'}
				</button>
			</div>
		{/snippet}

		{#if formOpen}
			<form class="mt-3 grid gap-2 rounded-xl border border-base-300/60 bg-base-200/40 p-3 text-sm" onsubmit={submitStart}>
				<fieldset class="fieldset">
					<legend class="fieldset-legend text-xs">What do you want to research?</legend>
					<textarea
						class="textarea textarea-bordered text-sm"
						bind:value={formQuery}
						placeholder="e.g. Compare lithium iron phosphate vs lithium polymer batteries for efoils"
						rows="2"
						maxlength="2000"
						required
					></textarea>
				</fieldset>
				<div class="flex flex-wrap items-center justify-between gap-2 text-xs">
					<div class="flex items-center gap-2">
						<span class="text-base-content/60">Model:</span>
						<ModelSelector
							size="xs"
							variant="inline"
							value={formModel}
							onchange={(id) => {
								formModel = id;
							}}
						/>
					</div>
				</div>
				{#if formError}
					<div class="alert alert-error py-2 text-xs">{formError}</div>
				{/if}
				<div class="flex justify-end gap-2">
					<button type="button" class="btn btn-xs btn-ghost" onclick={() => (formOpen = false)} disabled={starting}>
						Cancel
					</button>
					<button type="submit" class="btn btn-xs btn-primary" disabled={starting}>
						{starting ? 'Starting…' : 'Start research'}
					</button>
				</div>
			</form>
		{/if}
	</ContentPanel>

	{#if loading}
		<div class="flex justify-center py-20">
			<span class="loading loading-spinner loading-lg text-primary"></span>
		</div>
	{:else if error}
		<div class="alert alert-error text-sm">{error}</div>
	{:else if runs.length === 0}
		<div class="card card-body bg-base-200/30 border-base-300/60 rounded-2xl border p-12 text-center text-sm text-base-content/55">
			No research runs yet. Start one above to investigate a topic across multiple sources.
		</div>
	{:else}
		<ul class="space-y-2">
			{#each runs as r (r.id)}
				{@const inFlight = isInFlight(r.status)}
				<li>
					<a href="/research/{r.id}" class="flex flex-col gap-1.5 rounded-xl border border-base-300/60 bg-base-100 p-3 transition-colors hover:bg-base-200/40">
						<div class="flex items-start justify-between gap-2">
							<p class="line-clamp-2 flex-1 font-medium leading-tight">{r.query}</p>
							<span class="badge badge-sm {statusTone(r.status)}">{r.status}{inFlight ? '…' : ''}</span>
						</div>
						<div class="flex flex-wrap items-center gap-3 text-xs text-base-content/55">
							<span>Started {relativeTime(r.startedAt)}</span>
							{#if r.finishedAt}<span>· Finished {fmtDate(r.finishedAt)}</span>{/if}
							{#if parseFloat(r.costUsd) > 0}<span>· ${parseFloat(r.costUsd).toFixed(4)}</span>{/if}
							{#if r.plan && r.plan.length > 0}<span>· {r.plan.length} sub-question{r.plan.length === 1 ? '' : 's'}</span>{/if}
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>
