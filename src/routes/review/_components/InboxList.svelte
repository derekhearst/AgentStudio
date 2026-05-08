<script lang="ts">
	import {
		listReviewItemsQuery,
		resolveReviewItemCommand,
	} from '$lib/observability/review.remote';

	type Result = Awaited<ReturnType<typeof listReviewItemsQuery>>;
	type Inbox = Extract<Result, { adminOnly: false }>;

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
		{ value: 'pull_request_ready', label: 'Pull request ready' },
		{ value: 'automation_summary', label: 'Automation summary' },
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
		</div>
	{/if}
</div>
