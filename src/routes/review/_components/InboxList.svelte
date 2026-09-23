<script lang="ts">
	import {
		answerQuestionReviewItemCommand,
		decideApprovalReviewItemCommand,
		listReviewItemsQuery,
		resolveReviewItemCommand,
	} from '$lib/observability/review.remote';
	import { REVIEW_ITEM_TYPE_LABELS } from '$lib/observability/review-item-labels';
	import { startPullRequestFixCommand } from '$lib/source-control/source-control.remote';
	import { describeFixRunJob } from '$lib/source-control/pr-fix';
	import { remoteErrorMessage } from '$lib/ui/remote-error';
	import AskUserCard from '$lib/chat/AskUserCard.svelte';
	import { renderMarkdown } from '$lib/chat/chat';

	type Result = Awaited<ReturnType<typeof listReviewItemsQuery>>;
	type Inbox = Extract<Result, { adminOnly: false }>;
	type InboxItem = Inbox['items'][number];

	/**
	 * A maintenance automation's output — the weekly usage digest (#38) or a model-written
	 * summary — is markdown meant to be read, not a JSON string with `\n` escapes. Rendered
	 * through the chat's sanitizing renderer, because a model-written summary is untrusted.
	 */
	function automationSummary(item: InboxItem): string | null {
		if (item.type !== 'automation_summary') return null;
		const summary = item.payload.summary;
		return typeof summary === 'string' && summary.trim() ? summary : null;
	}

	let {
		inbox,
		typeFilter = $bindable(),
		statusFilter = $bindable(),
		severityFilter = $bindable(),
		onChange,
	}: {
		inbox: Inbox;
		typeFilter: string;
		statusFilter: string;
		severityFilter: string;
		onChange: () => void;
	} = $props();

	let expanded = $state<Set<string>>(new Set());

	// One entry per review item type the database knows, so the filter cannot offer a type
	// the server refuses (it did, for "PR checks failed").
	const TYPES = [
		{ value: '', label: 'All types' },
		...Object.entries(REVIEW_ITEM_TYPE_LABELS).map(([value, label]) => ({ value, label })),
	];

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
			onChange();
		} catch (e) {
			alert(remoteErrorMessage(e, 'Failed to resolve'));
		}
	}

	/**
	 * Approval requests and agent questions are answered, not resolved: the answer goes to
	 * the paused run, exactly as the chat's cards send it, and the item closes because of it.
	 */
	let answering = $state<string | null>(null);

	const NOT_ANSWERED: Record<string, string> = {
		no_longer_waiting: 'The run is no longer waiting for this, so the item was closed.',
		already_closed: 'This item was already closed.',
		not_found: 'This item no longer exists.',
		not_yours: 'This run belongs to someone else.',
		wrong_type: 'This item cannot be answered here.',
	};

	async function answered(result: { resolved: boolean; reason?: string }) {
		if (!result.resolved) alert(NOT_ANSWERED[result.reason ?? ''] ?? 'The run did not take the answer.');
		onChange();
	}

	async function handleDecision(itemId: string, approved: boolean) {
		answering = itemId;
		try {
			await answered(await decideApprovalReviewItemCommand({ itemId, approved }));
		} catch (e) {
			alert(remoteErrorMessage(e, approved ? 'Failed to approve' : 'Failed to deny'));
		} finally {
			answering = null;
		}
	}

	async function handleAnswers(itemId: string, answers: Record<string, string>) {
		answering = itemId;
		try {
			await answered(await answerQuestionReviewItemCommand({ itemId, answers }));
		} catch (e) {
			alert(remoteErrorMessage(e, 'Failed to send the answer'));
		} finally {
			answering = null;
		}
	}

	type QuestionPayload = {
		questions?: Array<{
			header: string;
			question: string;
			options: Array<{ label: string; description?: string; recommended?: boolean }>;
			allowFreeformInput?: boolean;
		}>;
	};

	function fmtDate(d: Date | string) {
		return new Date(d).toLocaleString();
	}

	/**
	 * #20 — "Fix it" on a CI failure. The inbox stays generic: it does not know what a
	 * pull request is, only that a payload carrying `fixCommand: 'pr_fix'` has an action
	 * available and which ids to pass along. The work is enqueued, so the button returns
	 * immediately and the agent's reply lands in the conversation that opened the PR.
	 */
	let fixing = $state<string | null>(null);

	type FixablePayload = { fixCommand?: string; pullRequestId?: string; checkName?: string };

	function fixTarget(payload: Record<string, unknown>): FixablePayload | null {
		const p = payload as FixablePayload;
		if (p.fixCommand !== 'pr_fix' || typeof p.pullRequestId !== 'string') return null;
		return p;
	}

	async function handleFix(itemId: string, payload: Record<string, unknown>) {
		const target = fixTarget(payload);
		if (!target?.pullRequestId) return;
		fixing = itemId;
		try {
			const result = await startPullRequestFixCommand({
				pullRequestId: target.pullRequestId,
				checkName: target.checkName ?? null,
				reviewItemId: itemId,
			});
			// A second press returns the item's first job, which may already be finished or
			// failed — say which, rather than claiming a fresh run was queued.
			alert(describeFixRunJob(result));
			onChange();
		} catch (e) {
			alert(remoteErrorMessage(e, 'Failed to queue the fix run'));
		} finally {
			fixing = null;
		}
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

<div class="space-y-3 sm:space-y-4">
	<!-- Filter row -->
	<div class="flex flex-wrap items-center gap-2">
		<select class="select select-sm select-bordered text-xs" bind:value={typeFilter} onchange={onChange}>
			{#each TYPES as opt (opt.value)}
				<option value={opt.value}>{opt.label}</option>
			{/each}
		</select>
		<select class="select select-sm select-bordered text-xs" bind:value={statusFilter} onchange={onChange}>
			<option value="">Open queue</option>
			<option value="open">Open</option>
			<option value="in_progress">In progress</option>
			<option value="resolved">Resolved</option>
			<option value="dismissed">Dismissed</option>
		</select>
		<select class="select select-sm select-bordered text-xs" bind:value={severityFilter} onchange={onChange}>
			<option value="">All severities</option>
			<option value="critical">Critical</option>
			<option value="warning">Warning</option>
			<option value="info">Info</option>
		</select>
	</div>

	<!-- Rollup -->
	{#if inbox.rollup.length > 0}
		<div>
			<p class="mb-2 text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Last 24h by type + status</p>
			<div class="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
				{#each inbox.rollup as row (row.type + row.status)}
					<div class="rounded-xl border border-base-300/60 bg-base-100 p-2.5">
						<div class="flex items-center gap-1.5">
							<span class="text-xs font-mono">{row.type}</span>
							<span class="badge badge-xs {statusTone(row.status)}">{row.status}</span>
						</div>
						<p class="mt-1 text-2xl font-bold leading-tight">{row.count}</p>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Items -->
	{#if inbox.items.length === 0}
		<div class="rounded-xl border border-base-300/60 bg-base-200/30 p-6 text-center text-sm text-base-content/55">
			No review items match the current filters.
		</div>
	{:else}
		<div>
			<div class="mb-2 flex items-center justify-between">
				<p class="text-[10px] font-semibold uppercase tracking-wide text-base-content/55">Items</p>
				<span class="badge badge-sm badge-ghost">{inbox.items.length}</span>
			</div>
			<ul class="space-y-1.5">
				{#each inbox.items as item (item.id)}
					{@const isOpen = expanded.has(item.id)}
					<li class="rounded-xl border border-base-300/60 bg-base-100">
						<button
							type="button"
							class="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-base-200/40 tablet:flex-nowrap"
							onclick={() => toggleExpand(item.id)}
						>
							<span class="badge badge-xs {severityTone(item.severity)}">{item.severity}</span>
							<span class="badge badge-xs badge-outline">{typeLabel(item.type)}</span>
							<span class="badge badge-xs {statusTone(item.status)}">{item.status}</span>
							<!-- On a phone the badges and date fill the row, and a flex-1 summary shrank to
							     nothing — every item's text was invisible. It takes its own line there. -->
							<span class="order-last line-clamp-1 w-full text-xs leading-tight tablet:order-none tablet:w-auto tablet:min-w-0 tablet:flex-1">{item.summary ?? '(no summary)'}</span>
							<span class="font-mono text-xs text-base-content/40">{fmtDate(item.createdAt)}</span>
							<svg class="size-3 transition-transform {isOpen ? 'rotate-180' : ''}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="3 5 6 8 9 5" />
							</svg>
						</button>
						{#if isOpen}
							{@const summaryMarkdown = automationSummary(item)}
							<div class="space-y-2 border-t border-base-300/60 px-3 py-3 text-xs">
								{#if summaryMarkdown}
									<div class="markdown-body max-h-96 overflow-auto rounded-lg bg-base-200/60 p-3 text-xs" data-testid="inbox-automation-summary">
										{@html renderMarkdown(summaryMarkdown)}
									</div>
								{/if}
								{#if item.runId}
									<p>
										<span class="font-semibold uppercase tracking-wide opacity-50">Run:</span>
										<a href="/runs/{item.runId}" class="link link-hover ml-1 font-mono">{item.runId}</a>
										<a href="/review/trace/{item.runId}" class="link link-hover ml-2 text-[10px] opacity-70">trace →</a>
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
								{#if (item.status === 'open' || item.status === 'in_progress') && item.type === 'approval_request'}
									<div class="flex gap-2 pt-2">
										<button
											class="btn btn-xs btn-success"
											type="button"
											disabled={answering === item.id}
											onclick={() => handleDecision(item.id, true)}
										>
											Approve
										</button>
										<button
											class="btn btn-xs btn-error btn-outline"
											type="button"
											disabled={answering === item.id}
											onclick={() => handleDecision(item.id, false)}
										>
											Deny
										</button>
									</div>
								{:else if (item.status === 'open' || item.status === 'in_progress') && item.type === 'user_question'}
									<div class="pt-2">
										<AskUserCard
											questions={(item.payload as QuestionPayload).questions ?? []}
											status={answering === item.id ? 'executing' : 'pending'}
											onSubmit={(answers: Record<string, string>) => handleAnswers(item.id, answers)}
										/>
									</div>
								{:else if item.status === 'open' || item.status === 'in_progress'}
									<div class="flex gap-2 pt-2">
										{#if fixTarget(item.payload)}
											<button
												class="btn btn-xs btn-primary"
												type="button"
												disabled={fixing === item.id}
												onclick={() => handleFix(item.id, item.payload)}
											>
												{fixing === item.id ? 'Queueing…' : 'Fix it'}
											</button>
										{/if}
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
		</div>
	{/if}
</div>
