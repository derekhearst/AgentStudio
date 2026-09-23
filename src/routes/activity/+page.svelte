<svelte:head><title>Activity | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listActivity } from '$lib/activity';
	import { getUsageDigest } from '$lib/costs/usage-digest.remote';
	import {
		DEFAULT_USAGE_DIGEST_DAYS,
		USAGE_DIGEST_WINDOW_DAYS,
		digestWindowLabel,
		type UsageDigest,
		type UsageDigestWindowDays,
	} from '$lib/costs/usage-digest';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import UsageStrip from './_components/UsageStrip.svelte';

	type ActivityRow = Awaited<ReturnType<typeof listActivity>>[number];
	type EventType = ActivityRow['type'];

	let events = $state<ActivityRow[]>([]);
	let filterType = $state<EventType | ''>('');
	let loading = $state(true);

	// #38 — the usage strip's window. A week by default: long enough to be a pattern, short
	// enough that the previous week is a fair comparison.
	let days = $state<UsageDigestWindowDays>(DEFAULT_USAGE_DIGEST_DAYS);
	let digest = $state<UsageDigest | null>(null);
	let digestLoading = $state(true);
	let digestError = $state<string | null>(null);

	const eventTypes: Array<{ value: EventType | ''; label: string }> = [
		{ value: '', label: 'All' },
		{ value: 'task_created', label: 'Task Created' },
		{ value: 'task_status_changed', label: 'Status Changed' },
		{ value: 'agent_action', label: 'Agent Action' },
		{ value: 'chat_started', label: 'Chat' },
		{ value: 'review_action', label: 'Review' },
		{ value: 'skill_created', label: 'Skill' },
		{ value: 'project_created', label: 'Project Created' },
		{ value: 'project_status_changed', label: 'Project Status' },
		{ value: 'goal_created', label: 'Goal Created' },
		{ value: 'strategy_submitted', label: 'Strategy Submitted' },
		{ value: 'strategy_approved', label: 'Strategy Approved' },
		{ value: 'strategy_rejected', label: 'Strategy Rejected' },
	];

	onMount(() => {
		void refresh();
		void loadDigest();
	});

	async function loadDigest(force = false) {
		digestLoading = true;
		digestError = null;
		const requested = days;
		let result: UsageDigest | null = null;
		try {
			const query = getUsageDigest({ days: requested });
			// A failed answer stays cached until the query that fetched it is garbage-collected,
			// so asking again for the same window could replay the failure: fetch it afresh.
			if (force || query.error) await query.refresh();
			result = await query;
		} catch {
			result = null;
		}
		// A slower answer for a window the user has already left must not overwrite the new one.
		if (requested !== days) return;
		digestLoading = false;
		if (result) {
			digest = result;
			return;
		}

		const shown = digest;
		if (!shown) {
			digestError = 'Usage numbers are unavailable right now.';
			return;
		}
		// Keep the numbers already on screen, but never let them pass for the window that failed.
		digestError =
			shown.days === requested
				? 'Could not refresh the usage numbers, so these may be out of date.'
				: `Could not load the last ${digestWindowLabel(requested)}. Showing the last ${digestWindowLabel(shown.days)}.`;
		// Press the window the numbers are for, so pressing the one that failed tries it again.
		days = USAGE_DIGEST_WINDOW_DAYS.find((option) => option === shown.days) ?? DEFAULT_USAGE_DIGEST_DAYS;
	}

	async function changeWindow(next: UsageDigestWindowDays) {
		if (next === days) return;
		days = next;
		await loadDigest();
	}

	function refreshAll() {
		void refresh();
		void loadDigest(true);
	}

	async function refresh() {
		loading = true;
		events = await listActivity({
			type: filterType || undefined,
			limit: 100,
		});
		loading = false;
	}

	async function changeFilter(type: EventType | '') {
		filterType = type;
		await refresh();
	}

	function entityLink(row: ActivityRow): string | null {
		if (!row.entityId || !row.entityType) return null;
		switch (row.entityType) {
			case 'task':
				return null;
			case 'agent':
				return `/agents/${row.entityId}`;
			case 'conversation':
				return `/chat/${row.entityId}`;
			default:
				return null;
		}
	}

	const badgeColor: Record<string, string> = {
		task_created: 'badge-info',
		task_status_changed: 'badge-warning',
		agent_action: 'badge-primary',
		chat_started: 'badge-success',
		review_action: 'badge-error',
		project_created: 'badge-info',
		project_status_changed: 'badge-warning',
		goal_created: 'badge-secondary',
		strategy_submitted: 'badge-primary',
		strategy_approved: 'badge-success',
		strategy_rejected: 'badge-error',
	};
</script>

<div class="flex h-full min-h-0 flex-col">
	<PageHeader title="Activity feed" subtitle="What the agents did, then every event as it happened">
		{#snippet actions()}
			<button class="btn btn-ghost btn-xs" type="button" onclick={refreshAll}>Refresh</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-4">
		<UsageStrip {digest} {days} loading={digestLoading} error={digestError} onWindowChange={changeWindow} />

		<div class="flex flex-wrap gap-1">
			{#each eventTypes as et (et.value)}
				<button
					class="btn btn-xs"
					class:btn-active={filterType === et.value}
					type="button"
					onclick={() => changeFilter(et.value)}
				>
					{et.label}
				</button>
			{/each}
		</div>

	{#if loading}
		<div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>
	{:else if events.length === 0}
		<p class="text-sm text-base-content/70">No activity events yet.</p>
	{:else}
		<div class="space-y-2">
			{#each events as event (event.id)}
				{@const link = entityLink(event)}
				<div class="flex items-start gap-3 card card-body bg-base-100 border-base-300 rounded-2xl border p-4">
					<span class="badge badge-sm {badgeColor[event.type] ?? ''} mt-0.5">{event.type.replace(/_/g, ' ')}</span>
					<div class="flex-1">
						<p class="text-sm">{event.summary}</p>
						<p class="text-xs text-base-content/55">{new Date(event.createdAt).toLocaleString()}</p>
					</div>
					{#if link}
						<a class="btn btn-xs btn-ghost" href={link}>View</a>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
	</div>
</div>

