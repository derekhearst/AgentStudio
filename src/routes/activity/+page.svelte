<svelte:head><title>Activity | AgentStudio</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listActivity } from '$lib/activity';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import { fetchFresh } from '$lib/ui/fresh-query';
	import { remoteErrorMessage } from '$lib/ui/remote-error';

	type ActivityRow = Awaited<ReturnType<typeof listActivity>>[number];
	type EventType = ActivityRow['type'];

	let events = $state<ActivityRow[]>([]);
	let filterType = $state<EventType | ''>('');
	let loading = $state(true);
	let error = $state<string | null>(null);

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
	});

	// There was no `try` here at all: a failed load left `loading` true for good.
	async function refresh() {
		loading = true;
		error = null;
		try {
			// Fresh, so the Refresh button actually brings in new events.
			events = await fetchFresh(
				listActivity({
					type: filterType || undefined,
					limit: 100,
				}),
			);
		} catch (err) {
			error = remoteErrorMessage(err, 'Could not load activity.');
		} finally {
			loading = false;
		}
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
	<PageHeader title="Activity feed" subtitle="Chronological stream of all system activity">
		{#snippet actions()}
			<button class="btn btn-ghost btn-xs" type="button" onclick={refresh} disabled={loading}>
				{loading ? 'Loading…' : 'Refresh'}
			</button>
		{/snippet}
	</PageHeader>

	<div class="min-h-0 flex-1 overflow-y-auto px-3 py-3 tablet:px-4 desktop:px-4 desktop:py-4 space-y-4">
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

	<!--
		A failed refresh shows its error above the events it already had, rather than in their
		place, and only the first load shows a spinner.
	-->
	{#if error}
		<div role="alert" class="alert alert-error py-2 text-sm">{error}</div>
	{/if}
	{#if loading && events.length === 0}
		<div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>
	{:else if events.length === 0}
		{#if !error}
			<p class="text-sm text-base-content/70">No activity events yet.</p>
		{/if}
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

