<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		getResearchDetailQuery,
		cancelResearchCommand,
	} from '$lib/research/research.remote';
	import type { ResearchPlanProposal } from '$lib/chat/tool-block-helpers';
	import { artifactDrawer } from '$lib/artifacts/artifact-drawer.svelte';

	type ResearchDetail = NonNullable<Awaited<ReturnType<typeof getResearchDetailQuery>>>;
	type ToolStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'denied' | 'failed';

	let {
		pendingPlan = null,
		pendingToken = null,
		pendingStatus = null,
		activeResearchId = null,
		onApprove,
		onDeny,
	} = $props<{
		pendingPlan?: ResearchPlanProposal | null;
		pendingToken?: string | null;
		pendingStatus?: ToolStatus | null;
		activeResearchId?: string | null;
		onApprove?: ((token: string) => void | Promise<void>) | undefined;
		onDeny?: ((token: string) => void | Promise<void>) | undefined;
	}>();

	let detail = $state<ResearchDetail | null>(null);
	let detailError = $state<string | null>(null);
	let canceling = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	$effect(() => {
		const id = activeResearchId;
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		if (!id) {
			detail = null;
			detailError = null;
			return;
		}
		void loadDetail(id);
		pollTimer = setInterval(() => {
			if (detail && isInFlight(detail.research.status)) void loadDetail(id);
		}, 3000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});

	async function loadDetail(id: string) {
		try {
			detail = await getResearchDetailQuery(id);
			detailError = null;
		} catch (err) {
			detailError = err instanceof Error ? err.message : 'Failed to load research';
		}
	}

	function isInFlight(status: string): boolean {
		return ['planning', 'searching', 'fetching', 'reflecting', 'synthesizing'].includes(status);
	}

	function statusLabel(status: string): string {
		switch (status) {
			case 'planning':
				return 'Planning…';
			case 'searching':
				return 'Searching the web…';
			case 'fetching':
				return 'Fetching pages…';
			case 'reflecting':
				return 'Reflecting on coverage…';
			case 'synthesizing':
				return 'Writing the report…';
			case 'complete':
				return 'Complete';
			case 'failed':
				return 'Failed';
			case 'canceled':
				return 'Canceled';
			default:
				return status;
		}
	}

	function statusTone(status: string): string {
		if (status === 'complete') return 'badge-success';
		if (status === 'failed') return 'badge-error';
		if (status === 'canceled') return 'badge-neutral';
		return 'badge-info';
	}

	async function handleApprove() {
		if (!pendingToken || !onApprove) return;
		await onApprove(pendingToken);
	}

	async function handleDeny() {
		if (!pendingToken || !onDeny) return;
		await onDeny(pendingToken);
	}

	async function handleCancel() {
		if (!activeResearchId) return;
		if (!confirm('Cancel this research run? In-flight LLM calls may still complete in the background.')) return;
		canceling = true;
		try {
			await cancelResearchCommand(activeResearchId);
			await loadDetail(activeResearchId);
		} finally {
			canceling = false;
		}
	}

	function openInDrawer() {
		if (!activeResearchId) return;
		artifactDrawer.open({ kind: 'research', id: activeResearchId });
	}

	const showPending = $derived(!!pendingPlan && pendingStatus === 'pending');
	const showRunning = $derived(!showPending && !!detail && isInFlight(detail.research.status));
	const showComplete = $derived(!showPending && !!detail && detail.research.status === 'complete');
	const showFailed = $derived(
		!showPending && !!detail && (detail.research.status === 'failed' || detail.research.status === 'canceled'),
	);

	const containerTone = $derived.by(() => {
		if (showComplete) return 'border-success/50 bg-success/5';
		if (showFailed) return 'border-error/50 bg-error/5';
		if (showRunning) return 'border-info/40 bg-info/5';
		return 'border-warning/50 bg-warning/5';
	});
</script>

{#if showPending && pendingPlan}
	<article class="research-inline-card chat chat-start w-full">
		<div class="card card-body w-full max-w-full rounded-2xl border {containerTone} px-4 py-3">
			<header class="mb-2 flex items-center gap-2 text-sm">
				<span class="badge badge-sm badge-warning">Research plan awaiting approval</span>
			</header>

			<p class="text-sm font-medium leading-snug">{pendingPlan.summary}</p>

			{#if pendingPlan.rationale}
				<p class="mt-1 text-xs leading-snug text-base-content/70">{pendingPlan.rationale}</p>
			{/if}

			<div class="mt-3">
				<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/60">
					Sub-questions ({pendingPlan.subQuestions.length})
				</p>
				<ol class="list-inside list-decimal space-y-1 text-sm leading-snug">
					{#each pendingPlan.subQuestions as q (q)}
						<li>{q}</li>
					{/each}
				</ol>
			</div>

			{#if pendingToken && (onApprove || onDeny)}
				<footer class="mt-3 flex flex-col gap-2 border-t border-base-300/40 pt-3">
					<div class="flex items-center justify-end gap-2">
						{#if onDeny}
							<button class="btn btn-ghost btn-sm" type="button" onclick={handleDeny}>
								Decline
							</button>
						{/if}
						{#if onApprove}
							<button class="btn btn-success btn-sm" type="button" onclick={handleApprove}>
								Approve & run
							</button>
						{/if}
					</div>
					<p class="text-center text-xs text-base-content/55">
						Or reply in the chat to refine the plan.
					</p>
				</footer>
			{/if}
		</div>
	</article>
{:else if showRunning && detail}
	{@const r = detail.research}
	<article class="research-inline-card chat chat-start w-full">
		<div class="card card-body w-full max-w-full rounded-2xl border {containerTone} px-4 py-3">
			<header class="mb-2 flex items-center gap-2 text-sm">
				<span class="badge badge-sm {statusTone(r.status)}">{statusLabel(r.status)}</span>
				<span class="loading loading-spinner loading-xs text-info"></span>
			</header>

			<p class="text-sm font-medium leading-snug">{r.query}</p>

			{#if r.plan && r.plan.length > 0}
				<div class="mt-3">
					<p class="mb-1 text-xs font-semibold uppercase tracking-wide text-base-content/60">
						Sub-questions ({r.plan.length})
					</p>
					<ol class="list-inside list-decimal space-y-1 text-sm leading-snug">
						{#each r.plan as q (q)}
							<li>{q}</li>
						{/each}
					</ol>
				</div>
			{/if}

			<div class="mt-3 flex flex-wrap gap-3 border-t border-base-300/40 pt-2 text-xs text-base-content/65">
				<span><span class="font-semibold">{detail.sources.length}</span> sources fetched</span>
				<span><span class="font-semibold">{detail.steps.length}</span> steps</span>
				{#if parseFloat(r.costUsd) > 0}
					<span>${parseFloat(r.costUsd).toFixed(4)}</span>
				{/if}
			</div>

			<footer class="mt-3 flex items-center justify-between gap-2 border-t border-base-300/40 pt-3">
				<button class="btn btn-sm btn-primary" type="button" onclick={openInDrawer}>
					View live trace →
				</button>
				<button
					class="btn btn-ghost btn-xs text-error"
					type="button"
					onclick={handleCancel}
					disabled={canceling}
				>
					{canceling ? 'Canceling…' : 'Cancel'}
				</button>
			</footer>
		</div>
	</article>
{:else if showComplete && detail}
	{@const r = detail.research}
	<article class="research-inline-card chat chat-start w-full">
		<div class="card card-body w-full max-w-full rounded-2xl border {containerTone} px-4 py-3">
			<header class="mb-2 flex items-center gap-2 text-sm">
				<span class="badge badge-sm badge-success">Research complete</span>
			</header>

			<p class="text-sm font-medium leading-snug">{r.query}</p>

			<div class="mt-3 flex flex-wrap gap-3 text-xs text-base-content/65">
				<span><span class="font-semibold">{detail.sources.length}</span> sources</span>
				<span>
					<span class="font-semibold">{detail.sources.filter((s) => s.citedInReport).length}</span>
					cited
				</span>
				{#if parseFloat(r.costUsd) > 0}
					<span>${parseFloat(r.costUsd).toFixed(4)}</span>
				{/if}
			</div>

			<footer class="mt-3 border-t border-base-300/40 pt-3">
				<button class="btn btn-sm btn-success w-full" type="button" onclick={openInDrawer}>
					Open report →
				</button>
			</footer>
		</div>
	</article>
{:else if showFailed && detail}
	{@const r = detail.research}
	<article class="research-inline-card chat chat-start w-full">
		<div class="card card-body w-full max-w-full rounded-2xl border {containerTone} px-4 py-3">
			<header class="mb-2 flex items-center gap-2 text-sm">
				<span class="badge badge-sm {statusTone(r.status)}">{statusLabel(r.status)}</span>
			</header>

			<p class="text-sm font-medium leading-snug">{r.query}</p>

			{#if r.error}
				<p class="mt-2 rounded bg-error/10 p-2 text-xs leading-snug text-error">{r.error}</p>
			{/if}

			<footer class="mt-3 border-t border-base-300/40 pt-3">
				<button class="btn btn-sm btn-ghost" type="button" onclick={openInDrawer}>
					View trace →
				</button>
			</footer>
		</div>
	</article>
{:else if detailError}
	<article class="research-inline-card chat chat-start w-full">
		<div class="card card-body w-full max-w-full rounded-2xl border border-error/40 bg-error/5 px-4 py-3">
			<p class="text-xs text-error">{detailError}</p>
		</div>
	</article>
{/if}
