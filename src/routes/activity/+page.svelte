<svelte:head><title>Activity | DrokBot</title></svelte:head>

<script lang="ts">
	import { onMount } from 'svelte';
	import { listActivity } from '$lib/activity/activity.remote';

	type ActivityRow = Awaited<ReturnType<typeof listActivity>>[number];
	type EventType = ActivityRow['type'];

	let events = $state<ActivityRow[]>([]);
	let filterType = $state<EventType | ''>('');
	let loading = $state(true);

	const eventTypes: Array<{ value: EventType | ''; label: string }> = [
		{ value: '', label: 'All' },
		{ value: 'task_created', label: 'Task Created' },
		{ value: 'task_status_changed', label: 'Status Changed' },
		{ value: 'agent_action', label: 'Agent Action' },
		{ value: 'memory_created', label: 'Memory' },
		{ value: 'dream_cycle', label: 'Dream Cycle' },
		{ value: 'chat_started', label: 'Chat' },
		{ value: 'review_action', label: 'Review' },
	];

	onMount(() => {
		void refresh();
	});

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
				return `/tasks/${row.entityId}`;
			case 'agent':
				return `/agents/${row.entityId}`;
			case 'memory':
				return `/memory/${row.entityId}`;
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
		memory_created: 'badge-secondary',
		dream_cycle: 'badge-accent',
		chat_started: 'badge-success',
		review_action: 'badge-error',
	};
</script>

<section class="space-y-4">
	<header class="rounded-2xl border border-base-300 bg-base-100 p-4">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div>
				<h1 class="text-3xl font-bold">Activity Feed</h1>
				<p class="text-sm text-base-content/70">Chronological stream of all system activity.</p>
			</div>
			<button class="btn btn-outline btn-sm" type="button" onclick={refresh}>Refresh</button>
		</div>

		<div class="mt-3 flex flex-wrap gap-1">
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
	</header>

	{#if loading}
		<div class="flex justify-center p-8"><span class="loading loading-spinner loading-lg"></span></div>
	{:else if events.length === 0}
		<p class="text-sm text-base-content/70">No activity events yet.</p>
	{:else}
		<div class="space-y-2">
			{#each events as event (event.id)}
				{@const link = entityLink(event)}
				<div class="flex items-start gap-3 rounded-2xl border border-base-300 bg-base-100 p-4">
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
</section>
