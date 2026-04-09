<svelte:head><title>Memory Detail | AgentStudio</title></svelte:head>

<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import {
		getMemoryByIdQuery,
		getMemoryRelationsQuery,
		getRoomTunnelsQuery,
		getRelatedMemoriesQuery,
		listDreamingSessionsQuery,
	} from '$lib/memory';
	import ContentPanel from '$lib/ui/ContentPanel.svelte';

	const memoryId = $derived(page.params.id ?? '');

	type MemoryRow = NonNullable<Awaited<ReturnType<typeof getMemoryByIdQuery>>>;
	type RelatedRow = Awaited<ReturnType<typeof getRelatedMemoriesQuery>>[number];
	type RelationRow = Awaited<ReturnType<typeof getMemoryRelationsQuery>>[number];
	type TunnelRow = Awaited<ReturnType<typeof getRoomTunnelsQuery>>[number];
	type DreamingSessionRow = Awaited<ReturnType<typeof listDreamingSessionsQuery>>[number];

	let memory = $state<MemoryRow | null>(null);
	let related = $state<RelatedRow[]>([]);
	let relations = $state<RelationRow[]>([]);
	let tunnels = $state<TunnelRow[]>([]);
	let dreamingSessions = $state<DreamingSessionRow[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		if (!memoryId) return;
		loading = true;
		error = null;
		try {
			const [memoryResult, relatedResult, relationResult, sessions] = await Promise.all([
				getMemoryByIdQuery({ id: memoryId }),
				getRelatedMemoriesQuery({ id: memoryId, depth: 2 }),
				getMemoryRelationsQuery({ id: memoryId }),
				listDreamingSessionsQuery(),
			]);
			memory = memoryResult;
			related = relatedResult;
			relations = relationResult;
			dreamingSessions = sessions;
			tunnels = memoryResult?.roomId ? await getRoomTunnelsQuery({ roomId: memoryResult.roomId }) : [];
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Failed to load memory detail';
		} finally {
			loading = false;
		}
	}
</script>

<section class="flex h-full min-h-0 flex-col space-y-3 sm:space-y-4">
	<a class="btn btn-sm btn-outline w-fit gap-1" href="/memory">
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M15 19l-7-7 7-7" /></svg>
		Memory Explorer
	</a>

	{#if loading}
		<p class="text-sm text-base-content/70">Loading memory detail...</p>
	{:else if error}
		<p class="text-sm text-error">{error}</p>
	{:else if !memory}
		<p class="text-sm text-base-content/70">Memory not found.</p>
	{:else}
		<ContentPanel>
			{#snippet header()}
				<div>
					<h1 class="text-xl font-bold sm:text-3xl">Drawer Detail</h1>
					<p class="text-xs text-base-content/70 sm:text-sm">
						<span class="badge badge-sm">{memory?.category}</span>
						<span class="ml-1">importance {memory?.importance.toFixed(2)}</span>
						<span class="ml-1">&middot; {memory?.accessCount} access{memory?.accessCount !== 1 ? 'es' : ''}</span>
					</p>
					<p class="mt-1 text-xs text-base-content/60">
						Hall: {memory?.hallType} • Wing {memory?.wingId ? 'assigned' : 'unassigned'} • Room {memory?.roomId ? 'assigned' : 'unassigned'}
					</p>
				</div>
			{/snippet}
		</ContentPanel>

		<!-- Content -->
		<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
			<h2 class="pb-2 text-sm font-semibold text-base-content/60">Raw drawer content</h2>
			<p class="whitespace-pre-wrap text-sm leading-relaxed">{memory?.content}</p>
		</div>

		<!-- Relations & Related in a grid -->
		<div class="grid gap-3 sm:gap-4 lg:grid-cols-3">
			<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
				<h2 class="pb-2 text-sm font-semibold text-base-content/60">Tunnels</h2>
				{#if tunnels.length <= 1}
					<p class="py-3 text-center text-xs text-base-content/40">No cross-wing tunnel for this room.</p>
				{:else}
					<div class="space-y-2">
						{#each tunnels as tunnel (tunnel.roomId)}
							<div class="rounded-lg bg-base-200/40 px-3 py-2 text-sm">
								<p class="font-medium">{tunnel.wingName}</p>
								<p class="text-xs text-base-content/60">{tunnel.roomName}</p>
							</div>
						{/each}
					</div>
				{/if}

				<h2 class="mb-2 mt-4 text-sm font-semibold text-base-content/60">Dreaming Agent Sessions</h2>
				<div class="space-y-2">
					{#if dreamingSessions.length === 0}
						<p class="text-xs text-base-content/40">No sessions yet.</p>
					{:else}
						{#each dreamingSessions.slice(0, 5) as session (session.id)}
							<a class="block rounded-lg bg-base-200/40 px-3 py-2 text-sm hover:bg-base-200" href={`/chat/${session.id}`}>
								<p class="truncate">{session.title}</p>
								<p class="text-[11px] text-base-content/50">{new Date(session.updatedAt).toLocaleString()}</p>
							</a>
						{/each}
					{/if}
				</div>
			</div>

			<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
				<h2 class="pb-2 text-sm font-semibold text-base-content/60">Relation Graph</h2>
				{#if relations.length === 0}
					<p class="py-3 text-center text-xs text-base-content/40">No explicit relation edges yet.</p>
				{:else}
					<div class="space-y-2">
						{#each relations as relation (relation.id)}
							<div class="rounded-lg bg-base-200/40 px-3 py-2 text-sm">
								<p class="font-medium">
									{relation.direction === 'outgoing' ? 'This memory' : 'Neighbor'}
									<span class="mx-1 text-xs text-base-content/50">{relation.relationType}</span>
									{relation.direction === 'outgoing' ? 'neighbor' : 'this memory'}
								</p>
								<p class="mt-0.5 text-xs text-base-content/60">{relation.otherMemory?.content ?? 'Unknown memory'}</p>
								<p class="mt-0.5 text-[10px] text-base-content/40">strength {relation.strength.toFixed(2)}</p>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div class="rounded-xl border border-base-300 bg-base-100 p-3 sm:rounded-2xl sm:p-4">
				<h2 class="pb-2 text-sm font-semibold text-base-content/60">Related Memories</h2>
				{#if related.length === 0}
					<p class="py-3 text-center text-xs text-base-content/40">No related memories found yet.</p>
				{:else}
					<div class="space-y-2">
						{#each related as item (item.id)}
							<a class="block rounded-lg bg-base-200/40 px-3 py-2 text-sm transition-colors hover:bg-base-200" href={`/memory/${item.id}`}>
								<p class="line-clamp-2">{item.content}</p>
								<p class="mt-0.5 text-xs text-base-content/50">
									<span class="rounded-md bg-base-content/6 px-1.5 py-0.5">{item.category}</span>
									<span class="ml-1">imp {item.importance.toFixed(2)}</span>
								</p>
							</a>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</section>

