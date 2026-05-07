<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		getResearchDetailQuery,
		cancelResearchCommand,
	} from '$lib/research/research.remote';
	import type { ResearchPlanProposal } from '$lib/chat/tool-block-helpers';

	type ResearchDetail = NonNullable<Awaited<ReturnType<typeof getResearchDetailQuery>>>;
	type ToolStatus = 'pending' | 'approved' | 'executing' | 'completed' | 'denied' | 'failed';

	let {
		pendingPlan = null,
		pendingToken = null,
		pendingStatus = null,
		activeResearchId = null,
		onApprove,
		onDeny,
		onClose,
	} = $props<{
		pendingPlan?: ResearchPlanProposal | null;
		pendingToken?: string | null;
		pendingStatus?: ToolStatus | null;
		activeResearchId?: string | null;
		onApprove?: ((token: string) => void | Promise<void>) | undefined;
		onDeny?: ((token: string) => void | Promise<void>) | undefined;
		onClose?: (() => void) | undefined;
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

	const showPending = $derived(!!pendingPlan && pendingStatus === 'pending');
	const showRunning = $derived(!showPending && !!detail && isInFlight(detail.research.status));
	const showComplete = $derived(!showPending && !!detail && detail.research.status === 'complete');
	const showFailed = $derived(!showPending && !!detail && (detail.research.status === 'failed' || detail.research.status === 'canceled'));
</script>

<aside class="flex h-full w-full flex-col border-l border-base-300 bg-base-100">
	<header class="flex items-center justify-between border-b border-base-300 px-3 py-2">
		<div class="min-w-0 flex-1">
			<h2 class="text-sm font-semibold leading-tight">Deep Research</h2>
			<p class="truncate text-xs text-base-content/55">
				{#if showPending}Awaiting approval{:else if showRunning}Running{:else if showComplete}Report ready{:else if showFailed}{detail?.research.status === 'canceled' ? 'Canceled' : 'Failed'}{:else}No active research{/if}
			</p>
		</div>
		{#if onClose}
			<button class="btn btn-ghost btn-xs btn-circle" onclick={() => onClose?.()} aria-label="Close research panel" title="Close">
				✕
			</button>
		{/if}
	</header>

	<div class="flex-1 overflow-y-auto p-3 space-y-3">
		{#if showPending && pendingPlan}
			<section class="rounded-xl border border-warning/50 bg-warning/5 p-3">
				<div class="mb-2 flex items-center gap-2">
					<span class="badge badge-warning badge-sm">Plan awaiting approval</span>
				</div>

				<p class="mb-2 text-sm font-medium leading-snug">{pendingPlan.summary}</p>

				{#if pendingPlan.rationale}
					<p class="mb-3 text-xs leading-snug text-base-content/70">{pendingPlan.rationale}</p>
				{/if}

				<div>
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
								<button class="btn btn-ghost btn-sm" type="button" onclick={handleDeny}>Decline</button>
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
			</section>
		{:else if showRunning && detail}
			{@const r = detail.research}
			<section class="rounded-xl border border-info/30 bg-info/5 p-3">
				<div class="mb-2 flex items-center gap-2">
					<span class="badge badge-sm {statusTone(r.status)}">{statusLabel(r.status)}</span>
					<span class="loading loading-spinner loading-xs text-info"></span>
				</div>

				<p class="mb-3 text-sm font-medium leading-snug">{r.query}</p>

				{#if r.plan && r.plan.length > 0}
					<div class="mb-3">
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

				<div class="flex flex-wrap gap-3 border-t border-base-300/40 pt-2 text-xs text-base-content/65">
					<span><span class="font-semibold">{detail.sources.length}</span> sources fetched</span>
					{#if parseFloat(r.costUsd) > 0}
						<span>${parseFloat(r.costUsd).toFixed(4)}</span>
					{/if}
				</div>

				<footer class="mt-3 flex items-center justify-between gap-2 border-t border-base-300/40 pt-3">
					<a class="link link-hover text-xs" href="/research/{r.id}">View live trace →</a>
					<button class="btn btn-ghost btn-xs text-error" type="button" onclick={handleCancel} disabled={canceling}>
						{canceling ? 'Canceling…' : 'Cancel'}
					</button>
				</footer>
			</section>
		{:else if showComplete && detail}
			{@const r = detail.research}
			<section class="rounded-xl border border-success/40 bg-success/5 p-3">
				<div class="mb-2 flex items-center gap-2">
					<span class="badge badge-sm badge-success">Complete</span>
				</div>

				<p class="mb-3 text-sm font-medium leading-snug">{r.query}</p>

				<div class="mb-3 flex flex-wrap gap-3 text-xs text-base-content/65">
					<span><span class="font-semibold">{detail.sources.length}</span> sources</span>
					<span><span class="font-semibold">{detail.sources.filter((s) => s.citedInReport).length}</span> cited</span>
					{#if parseFloat(r.costUsd) > 0}
						<span>${parseFloat(r.costUsd).toFixed(4)}</span>
					{/if}
				</div>

				<footer class="flex flex-col gap-2 border-t border-base-300/40 pt-3">
					<a class="btn btn-success btn-sm w-full" href="/research/{r.id}">Open report →</a>
					<p class="text-center text-xs text-base-content/55">
						Also in <a class="link link-hover" href="/artifacts">/artifacts</a>.
					</p>
				</footer>
			</section>
		{:else if showFailed && detail}
			{@const r = detail.research}
			<section class="rounded-xl border border-error/40 bg-error/5 p-3">
				<div class="mb-2 flex items-center gap-2">
					<span class="badge badge-sm {statusTone(r.status)}">{statusLabel(r.status)}</span>
				</div>

				<p class="mb-2 text-sm font-medium leading-snug">{r.query}</p>

				{#if r.error}
					<p class="mt-2 rounded bg-error/10 p-2 text-xs leading-snug text-error">{r.error}</p>
				{/if}

				<footer class="mt-3 border-t border-base-300/40 pt-3">
					<a class="link link-hover text-xs" href="/research/{r.id}">View trace →</a>
				</footer>
			</section>
		{:else if detailError}
			<p class="rounded bg-error/10 p-3 text-xs text-error">{detailError}</p>
		{:else}
			<div class="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-base-content/55">
				<p class="font-medium">No active research yet.</p>
				<p>Switch to the Research agent and ask a substantive question. The plan will appear here for you to approve.</p>
			</div>
		{/if}
	</div>
</aside>
